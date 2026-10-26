// Where a run is, from the shell to the editor, over the session bus rather
// than through a settings key: a key is written to disk, and the whole dconf
// database with it, several times a second for as long as a macro runs.

export const LIVE_BUS_NAME = 'org.gnome.Shell';
export const LIVE_PATH = '/io/github/tbocek/Macroclickwerk';
export const LIVE_IFACE = 'io.github.tbocek.Macroclickwerk';

/**
 * `RunningSteps` is emitted whenever where a run is changes; `GetRunningSteps`
 * answers the same for an editor that has just opened. Both carry JSON:
 * `{ running: [{ macro, steps: [ids] }], edited?: [macro ids] }`.
 */
export const LIVE_XML = `
<node>
  <interface name="${LIVE_IFACE}">
    <method name="GetRunningSteps">
      <arg type="s" name="json" direction="out"/>
    </method>
    <signal name="RunningSteps">
      <arg type="s" name="json"/>
    </signal>
  </interface>
</node>`;
