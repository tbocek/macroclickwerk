// Condition evaluation. Cheap checks (pixel colour) never touch the network;
// only the `llm` type sends a screenshot to the configured endpoint.

import GLib from 'gi://GLib';

import type { ColorCondition, Condition, LlmCondition, Region } from './model.js';
import { describeCondition } from './model.js';
import { LlmClient, LlmError, type LlmSettings, type Verdict } from './llm.js';
import { reportProblem } from './problems.js';
import type { Config } from './store.js';
import { captureForLlm, captureRegion } from './screenshot.js';
import { averageColor, colorDistance, formatColor, parseColor } from './colours.js';

export interface EvaluationTrace {
    condition: string;
    result: boolean;
    detail: string;
    latencyMs: number;
}

export class ConditionEvaluator {
    private _llm = new LlmClient();
    private _config: Config;
    private _onTrace?: (trace: EvaluationTrace) => void;
    private _onFlash?: (region?: Region | null) => void;

    /**
     * `onFlash` shows a check's area on screen every time it is read, so a
     * running macro can be watched looking where it was meant to; null is the
     * whole screen. A callback because drawing belongs
     * to the shell UI, and this file also runs under plain gjs in the tests.
     */
    /** Called right before the screen is read, to take any outline down. */
    private _beforeCapture?: () => void;

    constructor(
        config: Config,
        onTrace?: (trace: EvaluationTrace) => void,
        onFlash?: (region?: Region | null) => void,
        beforeCapture?: () => void,
    ) {
        this._config = config;
        this._onTrace = onTrace;
        this._onFlash = onFlash;
        this._beforeCapture = beforeCapture;
    }

    setConfig(config: Config): void {
        this._config = config;
    }

    destroy(): void {
        this._destroyed = true;
        this._llm.destroy();
    }

    /**
     * Gone with the extension. A check whose capture was under way when that
     * happened ends there: no outline on a screen that may be the lock
     * screen by now, and no question sent to a model nobody is waiting on.
     */
    private _destroyed = false;

    private _stillWanted(): void {
        if (this._destroyed) {
            throw new Error('the extension was turned off');
        }
    }

    /** Evaluate a condition tree. Throws when a check cannot be answered. */
    async evaluate(condition: Condition | null | undefined): Promise<boolean> {
        if (!condition) {
            return true;
        }

        const started = GLib.get_monotonic_time();
        const { result, detail } = await this._evaluateInner(condition);
        const latencyMs = Math.round((GLib.get_monotonic_time() - started) / 1000);

        this._onTrace?.({
            condition: describeCondition(condition),
            result,
            detail,
            latencyMs,
        });
        return result;
    }

    private async _evaluateInner(condition: Condition): Promise<{ result: boolean; detail: string }> {
        switch (condition.type) {
            case 'always':
                return { result: true, detail: '' };

            case 'never':
                return { result: false, detail: '' };

            case 'not': {
                const inner = await this._evaluateInner(condition.of);
                return { result: !inner.result, detail: inner.detail };
            }

            case 'and': {
                if (condition.of.length === 0) {
                    return { result: true, detail: 'no sub-conditions' };
                }
                for (const child of condition.of) {
                    const inner = await this._evaluateInner(child);
                    if (!inner.result) {
                        return { result: false, detail: inner.detail };
                    }
                }
                return { result: true, detail: '' };
            }

            case 'or': {
                if (condition.of.length === 0) {
                    return { result: false, detail: 'no sub-conditions' };
                }
                let lastDetail = '';
                for (const child of condition.of) {
                    const inner = await this._evaluateInner(child);
                    if (inner.result) {
                        return { result: true, detail: inner.detail };
                    }
                    lastDetail = inner.detail;
                }
                return { result: false, detail: lastDetail };
            }

            case 'color':
                return this._evaluateColor(condition);

            case 'llm':
                return this._evaluateLlm(condition);
        }
    }

    /**
     * One colour against one colour: what the area averages to now, against
     * what it averaged to when it was picked, within the tolerance.
     *
     * One path covers both shapes — a 1×1 area averages to its own pixel — and
     * that is the point. This used to count pixels near the target and demand a
     * percentage of them, which asked individual pixels to match a *mean*: a
     * mean is a colour that need not be anywhere in the area, so the count was
     * routinely zero and the check could not come true however the screen
     * looked. Comparing an average to an average asks a question the numbers
     * can actually answer.
     */
    private async _evaluateColor(condition: ColorCondition): Promise<{ result: boolean; detail: string }> {
        const w = Math.max(1, condition.w);
        const h = Math.max(1, condition.h);
        this._beforeCapture?.();
        const pixbuf = await captureRegion(condition.x, condition.y, w, h);
        this._stillWanted();

        const actual = averageColor(pixbuf);
        const distance = colorDistance(actual, parseColor(condition.color));
        const outcome = {
            result: distance <= condition.tolerance,
            detail: `found ${formatColor(actual)}, distance ${distance.toFixed(1)} vs tolerance ${condition.tolerance}`,
        };

        // After the capture — a green outline over the area is exactly the sort
        // of thing a colour check would then measure — and after the scan,
        // which holds the main loop and would sit between the flash and its
        // first paint.
        this._onFlash?.({ x: condition.x, y: condition.y, w, h });
        return outcome;
    }

    /**
     * Ask the model one LLM check on the screen as it is now, and hand back
     * its verdict as it gave it. What a run evaluates, and what the editor's
     * Check now shows, so the two cannot disagree about what was asked.
     */
    async askLlm(condition: LlmCondition): Promise<Verdict> {
        // Endpoint, model and timeout are global settings: a per-condition copy
        // of each was more knobs than anyone wants on every prompt.
        const settings: LlmSettings = {
            endpoint: this._config.llmEndpoint,
            model: this._config.llmModel,
            apiKey: this._config.llmApiKey,
            timeoutMs: this._config.llmTimeoutMs,
            kind: this._config.llmKind,
            threshold: this._config.llmThreshold,
        };
        this._beforeCapture?.();
        const image = await captureForLlm(condition.region, this._config.llmMaxWidth);
        this._stillWanted();
        // After the capture — the flash must not be in the picture the model
        // is asked about — and after any encode, which blocks the main loop
        // and would sit between the flash and its first paint.
        this._onFlash?.(condition.region);
        return this._llm.ask(condition.prompt, image, settings);
    }

    private async _evaluateLlm(condition: LlmCondition): Promise<{ result: boolean; detail: string }> {
        try {
            const verdict = await this.askLlm(condition);
            const detail = `model said ${verdict.match ? 'yes' : 'no'}${verdict.reason ? ` — ${verdict.reason}` : ''} (${verdict.latencyMs}ms)`;
            return { result: verdict.match, detail };
        } catch (error) {
            const message = error instanceof LlmError ? error.message : (error as Error).message;
            // A failed check has no answer, and guessing one either way sends the
            // macro down a branch on no evidence. Say so and stop.
            reportProblem('Model', message, {
                where: describeCondition(condition),
                hint: `Macroclickwerk asked ${this._config.llmEndpoint || '(no endpoint set)'} — start that server, ` +
                    'point Settings → Setup at another model, or replace the check with a colour test.',
            });
            throw new Error(`the model could not answer: ${message}`);
        }
    }
}
