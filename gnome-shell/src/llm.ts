// Vision questions against a local, OpenAI-compatible chat completions endpoint
// (llama.cpp-server, LM Studio, vLLM, or Ollama's /v1 shim).
//
// Every call is asynchronous. A local vision model can take many seconds to
// answer and the compositor thread must never wait on it.

import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import type { EncodedImage } from './screenshot.js';

export interface LlmSettings {
    endpoint: string;
    model: string;
    apiKey: string;
    timeoutMs: number;
    /**
     * 'chat' asks an OpenAI-compatible chat endpoint for a JSON verdict.
     * 'decision' asks a decision model one yes/no question and gets a
     * probability back, with nothing generated. Chat when absent.
     */
    kind?: 'chat' | 'decision';
    /** For a decision model: how likely yes must be to count as yes. 0.5 when absent. */
    threshold?: number;
}

export interface Verdict {
    /** The answer to the question, after `expect` has been applied by the caller. */
    match: boolean;
    reason: string;
    latencyMs: number;
}

export class LlmError extends Error {}

/**
 * The server's own words when it sent any, not the whole JSON envelope: an
 * OpenAI-style error arrives as {"error":{"message":"model 'X' not found"}},
 * and repeating that raw in every problem row buried the one line that says
 * what is wrong.
 */
function httpErrorText(status: number, body: string): string {
    try {
        const parsed = JSON.parse(body) as { error?: { message?: string } | string };
        const message = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message;
        if (message) {
            return `HTTP ${status}: ${message.slice(0, 200)}`;
        }
    } catch {
        // Not JSON — the raw slice is all there is.
    }
    return `HTTP ${status}: ${body.slice(0, 200)}`;
}

/**
 * Deliberately blunt and repetitive. Small local vision models drift away from
 * a loose format immediately: they answer in prose, wrap JSON in a code fence,
 * or put the string "yes" where a boolean belongs. Spelling out the exact shape
 * — and what not to do — is worth more here than brevity.
 *
 * Exported because preferences shows it verbatim behind an info button. Nobody
 * can word a prompt well without knowing what it is wrapped in, and a copy of
 * this text in the help would be wrong within a release.
 */
export function buildInstruction(question: string): string {
    return [
        'You are a strict visual classifier. Look at the screenshot and decide whether',
        'the following statement is TRUE or FALSE for what you see.',
        '',
        `STATEMENT: ${question}`,
        '',
        'Reply with exactly one JSON object and nothing else.',
        'No prose. No explanation before or after. No markdown. No ``` code fence.',
        '',
        'The object must have exactly these two keys:',
        '  "match"  - the JSON boolean true or false. Not "true", not "yes", not 1.',
        '  "reason" - a string, at most 10 words.',
        '',
        'Valid replies look exactly like this:',
        '{"match": true, "reason": "the left button is green"}',
        '{"match": false, "reason": "the button is grey"}',
        '',
        'Use true only when the statement is clearly true in the screenshot.',
        'If you are unsure, or cannot see the thing being asked about, use false.',
    ].join('\n');
}

/**
 * The state a decision model is asked about. The picture is the state; this
 * only says what the picture is, so the question can say "the button" and be
 * understood as the one in the screenshot.
 */
const DECISION_STATE = 'A screenshot of a computer screen, or of the part of it being checked.';

/** The one question's id in a decision request, and so in its answer. */
const DECISION_QUESTION = 'check';

/**
 * Read a decision model's answer: the probability of yes for the one question
 * asked, against `threshold`. The reason says how sure it was of the answer it
 * gave, which is the part a chat model would have put into words.
 */
export function parseDecision(text: string, threshold: number): { match: boolean; reason: string } {
    let p: unknown;
    try {
        const json = JSON.parse(text) as {
            answers?: Record<string, { noul?: unknown }>;
            error?: { message?: string } | string;
        };
        if (json.error) {
            throw new LlmError(typeof json.error === 'string' ? json.error : json.error.message ?? 'the decision model reported an error');
        }
        p = json.answers?.[DECISION_QUESTION]?.noul;
    } catch (error) {
        if (error instanceof LlmError) {
            throw error;
        }
        throw new LlmError(`could not parse the decision: ${text.slice(0, 200)}`);
    }
    if (typeof p !== 'number' || !Number.isFinite(p)) {
        throw new LlmError(`the decision model gave no yes/no probability: ${text.slice(0, 200)}`);
    }
    const percent = (value: number) => `${Math.round(value * 100)}%`;
    const match = p >= threshold;
    if (match) {
        return { match, reason: `${percent(p)} sure` };
    }
    // A likely yes that the threshold turned into a no says so, or the answer
    // reads as the model being wrong rather than as the setting doing its job.
    return { match, reason: p >= 0.5 ? `${percent(p)} yes, short of ${percent(threshold)}` : `${percent(1 - p)} sure` };
}

/** Questions that ask for an answer in words. */
const ASKS_FOR_WORDS = /^(what|which|where|when|who|whom|whose|why|how)\b/;
/** Openings that make it an instruction rather than a question. */
const GIVES_ORDERS = /^(count|list|describe|find|tell|read|name|identify|give|show|extract|explain|locate|click|press|type|return|say|write|output|summari[sz]e)\b/;
/** Wording that makes Yes mean something is missing rather than there. */
const ASKS_ABOUT_ABSENCE = /\b(not|no longer|never|without|isn't|aren't|doesn't|don't|isn’t|aren’t|doesn’t|don’t|gone|missing|disappeared|absent)\b|n['’]t\b/;

/** Openings of a yes/no question — the only kind where an "or" picks between two. */
const ASKS_YES_NO = /^(is|are|am|was|were|does|do|did|has|have|had|can|could|will|would|should|shall|may|might|must)\b/;

/**
 * Whether a check's wording can be answered with yes or no, and if not, what
 * to do instead — or null when it can. Both kinds of model answer exactly that
 * and nothing else, so a question that wants a colour, a count or a choice
 * between two gets a yes or a no that means nothing, and the macro goes down
 * a branch on it. Caught as it is typed rather than when the macro misbehaves.
 *
 * Named are the mistakes that cannot be answered, and one that can but reads
 * backwards: a question about something being absent, which makes Yes mean
 * "it is not there". A statement that is true or false is as good as a
 * question, and "green or yellow" in a statement is still one fact.
 */
export function promptAdvice(text: string): string | null {
    const wording = text.trim().replace(/^["'“‘(]+/, '').toLowerCase();
    if (wording === '') {
        return 'Ask a yes/no question about what is on the screen — “Is the button green?”';
    }
    if (ASKS_FOR_WORDS.test(wording)) {
        return 'This asks for an answer in words, and the model can only say yes or no. Ask about what you ' +
            'expect instead: “Is the button green?” rather than “What colour is the button?”';
    }
    if (GIVES_ORDERS.test(wording)) {
        return 'This is an instruction, not a question. Make it something yes or no answers: ' +
            '“There are three enemies” rather than “Count the enemies”.';
    }
    if ((wording.match(/\?/g) ?? []).length > 1) {
        return 'This asks more than one thing, and one yes or no cannot answer both. ' +
            'Ask one per check — “All of” combines them.';
    }
    if (ASKS_YES_NO.test(wording) && /\bor\b/.test(wording)) {
        return 'A yes would not say which of the two. Ask about one: ' +
            '“Is the light green?” rather than “Is the light green or red?”';
    }
    // Answerable, but backwards: Yes should mean the thing you wait for is
    // there. A "not", or something gone, makes Yes mean an absence — easy to
    // misread, for the model and for whoever reads the macro later.
    // Quoted words are text on the screen, not the question's own: a label
    // that says “Not ready” is something to look for.
    if (ASKS_ABOUT_ABSENCE.test(wording.replace(/"[^"]*"|“[^”]*”/g, ''))) {
        return 'Ask what you expect to see, so that Yes means it is there: “Is the button green?” rather than ' +
            '“Is the button not green?”. Put what should happen otherwise in the If’s No branch.';
    }
    return null;
}

let promisified = false;

function ensurePromisified(): void {
    if (promisified) {
        return;
    }
    promisified = true;
    const gio = Gio as unknown as {
        _promisify: (proto: object, method: string, finish?: string) => void;
    };
    try {
        gio._promisify(Soup.Session.prototype, 'send_and_read_async', 'send_and_read_finish');
    } catch {
        // Already promisified.
    }
}

interface AsyncSoupSession {
    send_and_read_async(
        message: Soup.Message, priority: number, cancellable: Gio.Cancellable | null,
    ): Promise<GLib.Bytes>;
}

/** Keys small models reach for when they ignore the one we asked for. */
const VERDICT_KEYS = ['match', 'answer', 'result', 'value', 'verdict', 'is_true', 'true'];

function toBool(value: unknown): boolean | null {
    if (typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'number') {
        return value !== 0;
    }
    if (typeof value === 'string') {
        const text = value.trim().toLowerCase();
        if (['true', 'yes', 'y', '1'].includes(text)) {
            return true;
        }
        if (['false', 'no', 'n', '0'].includes(text)) {
            return false;
        }
    }
    return null;
}

/**
 * Drop a reasoning model's thinking. Servers usually hand it over in a separate
 * field, but some leave it inline, and its prose is full of braces and the words
 * yes and no — everything below would happily read a verdict out of it. An
 * unclosed tag means the answer was cut off mid-thought: nothing is left.
 */
function stripThinking(text: string): string {
    const without = text.replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, '');
    return without.replace(/<(think|thinking|reasoning)>[\s\S]*$/i, '').trim();
}

/**
 * Read the model's answer. Even with JSON mode on, small models produce fenced
 * blocks, stringly-typed booleans, alternate key names and trailing chatter, so
 * this accepts all of those before falling back to a plain YES/NO.
 */
export function parseVerdict(text: string): { match: boolean; reason: string } | null {
    const trimmed = stripThinking((text ?? '').trim());
    if (trimmed === '') {
        return null;
    }

    const object = verdictFromObjects(trimmed);
    if (object) {
        return object;
    }

    const word = /\b(yes|no|true|false)\b/i.exec(trimmed);
    if (word) {
        const value = word[1].toLowerCase();
        return { match: value === 'yes' || value === 'true', reason: trimmed.slice(0, 120) };
    }

    return null;
}

/**
 * The strict half of the reading: an actual JSON object, nothing inferred from
 * prose. Used on its own where a stray "true" in a sentence must not be mistaken
 * for an answer.
 */
export function verdictFromObjects(text: string): { match: boolean; reason: string } | null {
    const trimmed = stripThinking((text ?? '').trim());

    // Non-greedy from the first brace: models sometimes emit a second object
    // after the first, and JSON.parse would choke on the pair.
    for (const candidate of trimmed.match(/\{[\s\S]*?\}/g) ?? []) {
        try {
            const parsed = JSON.parse(candidate) as Record<string, unknown>;
            const reason = String(parsed.reason ?? parsed.explanation ?? '');
            for (const key of VERDICT_KEYS) {
                if (key in parsed) {
                    const value = toBool(parsed[key]);
                    if (value !== null) {
                        return { match: value, reason };
                    }
                }
            }
        } catch {
            // Try the next object, then fall through to the plain-text reading.
        }
    }

    return null;
}

// --- connection test -------------------------------------------------------

export interface ConnectionTest {
    /** The endpoint answered with something we could read a verdict out of. */
    ok: boolean;
    /** ...and it got a question about the picture right, so it can see images. */
    sawImage: boolean;
    latencyMs: number;
    /** The model's own words on success, the failure reason otherwise. */
    message: string;
}

/**
 * The picture the test sends: a plain red square, generated rather than stored
 * so there is no blob to keep in the source. Small enough to be instant, large
 * enough that servers which reject one-pixel images still take it.
 */
function testImage(): EncodedImage {
    const pixbuf = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, false, 8, 64, 64);
    if (!pixbuf) {
        throw new LlmError('could not build the test picture');
    }
    pixbuf.fill(0xff0000ff);   // RGBA, opaque red
    const [ok, data] = pixbuf.save_to_bufferv('png', [], []);
    if (!ok || !data) {
        throw new LlmError('could not encode the test picture');
    }
    return {
        dataUri: `data:image/png;base64,${GLib.base64_encode(data)}`,
        mimeType: 'image/png',
        byteLength: data.length,
        width: 64,
        height: 64,
    };
}

/**
 * Ask the configured endpoint one question it cannot get wrong. This exercises
 * the whole path a condition uses — URL, key, model name, image upload, verdict
 * parsing — so a green result means conditions will work, not merely that
 * something is listening on the port.
 */
export async function testConnection(settings: LlmSettings): Promise<ConnectionTest> {
    const client = new LlmClient();
    try {
        const verdict = await client.ask(
            'the picture is plain red, with nothing else in it', testImage(), settings);
        return { ok: true, sawImage: verdict.match, latencyMs: verdict.latencyMs, message: verdict.reason };
    } catch (error) {
        return { ok: false, sawImage: false, latencyMs: 0, message: (error as Error).message };
    } finally {
        client.destroy();
    }
}

/**
 * Room for the answer. The answer itself is a dozen tokens; the rest is headroom
 * for a reasoning model that thinks anyway, despite being asked not to. Getting
 * this wrong is not a bad answer but no answer at all: the budget runs out
 * mid-thought and the reply comes back empty.
 */
const MAX_TOKENS = 400;

export class LlmClient {
    private _session: Soup.Session;
    private _jsonMode = true;
    private _noThinking = true;

    constructor() {
        ensurePromisified();
        this._session = new Soup.Session();
    }

    destroy(): void {
        this._session.abort();
    }

    async ask(prompt: string, image: EncodedImage, settings: LlmSettings): Promise<Verdict> {
        if (!settings.endpoint) {
            throw new LlmError('no LLM endpoint configured');
        }
        return settings.kind === 'decision'
            ? this._askDecision(prompt, image, settings)
            : this._askChat(prompt, image, settings);
    }

    /**
     * A decision model is asked the statement as one yes/no question — a
     * `noul`, in the SystemOne schema — about a state that is the screenshot.
     * It answers with the probability of yes in a single forward pass, so
     * there is no text to parse and nothing to think about first.
     */
    private async _askDecision(prompt: string, image: EncodedImage, settings: LlmSettings): Promise<Verdict> {
        const { status, text, latencyMs } = await this._post({
            model: settings.model,
            state: DECISION_STATE,
            images: [image.dataUri],
            questions: { [DECISION_QUESTION]: { type: 'noul', instructions: prompt } },
        }, settings);
        if (status !== Soup.Status.OK) {
            throw new LlmError(httpErrorText(status, text));
        }
        return { ...parseDecision(text, settings.threshold ?? 0.5), latencyMs };
    }

    private async _askChat(prompt: string, image: EncodedImage, settings: LlmSettings): Promise<Verdict> {
        const body: Record<string, unknown> = {
            model: settings.model,
            temperature: 0,
            max_tokens: MAX_TOKENS,
            messages: [
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: buildInstruction(prompt) },
                        { type: 'image_url', image_url: { url: image.dataUri } },
                    ],
                },
            ],
        };

        // Constrained decoding, where the server supports it, is far more
        // reliable than asking nicely. Servers that do not understand the field
        // reject the request, so we remember that and stop sending it.
        if (this._jsonMode) {
            body.response_format = { type: 'json_object' };
        }

        // A reasoning model spends its whole budget deliberating over a picture
        // it recognises at a glance, and the answer arrives seconds late or not
        // at all. This is the switch that turns thinking off; templates that
        // have never heard of it ignore it.
        if (this._noThinking) {
            body.chat_template_kwargs = { enable_thinking: false };
        }

        const { status, text, latencyMs } = await this._post(body, settings);

        if (status !== Soup.Status.OK) {
            // A rejected request may be about either extra field, and there
            // is no telling which from the status alone. Give up the one we
            // can most afford to lose first, and try again.
            if (status === 400 && this._noThinking) {
                log('macroclickwerk: endpoint rejected chat_template_kwargs, retrying without it');
                this._noThinking = false;
                return this._askChat(prompt, image, settings);
            }
            if (status === 400 && this._jsonMode) {
                log('macroclickwerk: endpoint rejected response_format, retrying without JSON mode');
                this._jsonMode = false;
                return this._askChat(prompt, image, settings);
            }
            throw new LlmError(httpErrorText(status, text));
        }

        let content = '';
        let reasoning = '';
        let finish = '';
        try {
            const json = JSON.parse(text) as {
                choices?: {
                    finish_reason?: string;
                    message?: { content?: unknown; reasoning_content?: unknown };
                }[];
                error?: { message?: string };
            };
            if (json.error?.message) {
                throw new LlmError(json.error.message);
            }
            const choice = json.choices?.[0];
            finish = choice?.finish_reason ?? '';
            const raw = choice?.message?.content;
            if (typeof raw === 'string') {
                content = raw;
            } else if (Array.isArray(raw)) {
                // Some servers answer with the content-part array form.
                content = raw
                    .map(part => (typeof part === 'string' ? part : (part as { text?: string })?.text ?? ''))
                    .join(' ');
            }
            if (typeof choice?.message?.reasoning_content === 'string') {
                reasoning = choice.message.reasoning_content;
            }
        } catch (error) {
            if (error instanceof LlmError) {
                throw error;
            }
            throw new LlmError(`could not parse the response: ${text.slice(0, 200)}`);
        }

        // A reasoning model that would not be talked out of thinking
        // sometimes finishes the job inside its thoughts. Only a written-out
        // JSON object counts there: half a thought is full of the words true
        // and no, and reading a verdict out of one would be worse than
        // saying we could not find it.
        const parsed = parseVerdict(content) ?? verdictFromObjects(reasoning);
        if (!parsed) {
            // Naming the empty case separately: an error that ends in a
            // colon and then nothing reads like the message itself broke.
            if (content.trim() === '') {
                throw new LlmError(reasoning.trim() !== '' || finish === 'length'
                    ? 'the model spent its whole answer thinking and never got to the verdict'
                    : 'the model returned an empty answer');
            }
            throw new LlmError(`could not read a yes/no answer from: ${content.slice(0, 200)}`);
        }

        return { match: parsed.match, reason: parsed.reason, latencyMs };
    }

    /**
     * Send one JSON body to the endpoint and read back whatever came: the
     * status and the text, for the caller to judge. Owns the timeout, and
     * turns everything that is not an answer — a refused connection, a
     * timeout — into an LlmError.
     */
    private async _post(
        body: object,
        settings: LlmSettings,
    ): Promise<{ status: number; text: string; latencyMs: number }> {
        const message = Soup.Message.new('POST', settings.endpoint);
        if (!message) {
            throw new LlmError(`invalid endpoint URL: ${settings.endpoint}`);
        }
        if (settings.apiKey) {
            message.request_headers.append('Authorization', `Bearer ${settings.apiKey}`);
        }
        const payload = new TextEncoder().encode(JSON.stringify(body));
        message.set_request_body_from_bytes('application/json', new GLib.Bytes(payload));

        const cancellable = new Gio.Cancellable();
        let timeoutId = 0;
        let timedOut = false;
        if (settings.timeoutMs > 0) {
            timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, settings.timeoutMs, () => {
                timeoutId = 0;
                timedOut = true;
                cancellable.cancel();
                return GLib.SOURCE_REMOVE;
            });
        }

        const started = GLib.get_monotonic_time();
        try {
            const session = this._session as Soup.Session & AsyncSoupSession;
            const bytes = await session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable);
            return {
                status: message.get_status(),
                text: new TextDecoder().decode(bytes.get_data() ?? new Uint8Array(0)),
                latencyMs: Math.round((GLib.get_monotonic_time() - started) / 1000),
            };
        } catch (error) {
            if (timedOut) {
                throw new LlmError(`timed out after ${settings.timeoutMs}ms`);
            }
            throw new LlmError((error as Error).message ?? String(error));
        } finally {
            if (timeoutId) {
                GLib.source_remove(timeoutId);
            }
        }
    }
}
