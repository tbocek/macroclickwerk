// Load the built preferences module the way the Extensions app does — against
// the shell's own prefs.js resource, not a stub. Nothing here builds a window;
// the point is the import itself, because gettext refuses to run while the
// module is still being imported and a translated string at file scope takes
// the whole settings window down with a bare "gettext can only be called from
// extensions".
//
// Skips itself where gnome-shell is not installed, so the suite still runs.

import Gio from 'gi://Gio';
import Pango from 'gi://Pango';

const RESOURCE = '/usr/share/gnome-shell/org.gnome.Shell.Extensions.src.gresource';
// Relative to this file rather than to the working directory, so it does not
// matter where the suite is run from.
const PREFS = import.meta.url.replace(/\/test\/[^/]+$/, '/dist/prefs.js');

if (!Gio.File.new_for_path(RESOURCE).query_exists(null)) {
    print('skip prefs load: gnome-shell is not installed here');
} else {
    Gio.resources_register(Gio.resource_load(RESOURCE));
    try {
        await import(PREFS);
        print('ok   the preferences module imports against the real shell');
    } catch (error) {
        print(`FAIL preferences module does not import: ${error.message}`);
        print('     (a gettext call at file scope is the usual cause)');
        imports.system.exit(1);
    }

    // Row titles are Pango markup, and markup that does not parse is a title
    // that does not appear — a step described with an ampersand in it used to
    // be exactly that. Checked here rather than in the plain-gjs suite because
    // the widgets module wants the GTK stack this file already has.
    const { withColorSwatches } = await import(PREFS.replace(/prefs\.js$/, 'src/widgets.js'));
    for (const text of [
        'If pixel 840,512 ≈ #22aa33',
        'If 60% of 40×40 @ 1,2 ≈ #123456',
        'not (pixel 1,1 ≈ #2a3)',
        'Type "a & b" <fast>',
        'If always',
    ]) {
        const markup = withColorSwatches(text);
        try {
            const [, , plain] = Pango.parse_markup(markup, -1, '\0');
            const swatches = (markup.match(/<span/g) ?? []).length;
            const colours = (text.match(/#[0-9a-f]{3,6}/gi) ?? []).length;
            if (!plain.startsWith(text.split('#')[0]) || swatches !== colours) {
                print(`FAIL swatched title is not the title it swatched: ${markup}`);
                imports.system.exit(1);
            }
        } catch (error) {
            print(`FAIL swatched title is not valid markup: ${markup} — ${error.message}`);
            imports.system.exit(1);
        }
    }
    print('ok   every colour in a row title becomes a swatch, and the title stays markup');
}
