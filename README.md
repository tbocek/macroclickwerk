# Macroclickwerk

Record, edit and replay input macros on GNOME/Wayland — with loops, and with
conditions that can look at the screen.

![Macroclickwerk Extension Screenshot](docs/screenshot.png)

A macro is a tree of steps: clicks, key presses, typed text, scrolls, waits,
recorded event trains — and `on event`, which parks the run until a button or
key of your choosing is pressed (or, if you say so, released) and swallows
that event, so a side button can mean "do the next steps" instead of what it
normally does. Two of them on the two edges of one button make a hold: on
left press → press E, on left release → release E. Around them you can put `loop` and `if` blocks. A loop
only counts — forever, or a fixed number of times; you leave it with `break`
inside an `if`, which keeps every condition in one place:

- **screen colour** — "the pixel at 840,512 is green ±24", or "this 40×40 area
  averages to green ±30". Sub-5 ms, deterministic, no network. Both the spot
  and the colour come off the screen itself: **Pick** takes a click as one
  pixel and a drag as an area, and stores what that area averages to.
- **ask a local vision model** — a screenshot plus your own prompt ("Is the button
  on the left green?"), answered yes/no by an OpenAI-compatible endpoint running
  on your machine.
- **and / or / not** over the above, and **always** / **never** for a branch
  that is not deciding anything today.

The macro that ships on first run is the one this was built for:

```
repeat forever:
    if the model says the left button is green:
        click at x,y
        if a colour check passes:
            type E
    wait 10s
```

## Features

- **Recording** of real mouse and keyboard input, coalesced into readable steps:
  clicks carry their absolute screen position, pointer movement becomes a move
  step wherever it comes to rest, and idle gaps become waits.
- **A full tree editor in preferences** — every step and condition, nested
  loops and `and`/`or`/`not`, plain-language summaries, and JSON import/export
  to a file you choose.
- **A panel popup that stays out of the way** — a switch, a stop, what is
  running, and a way into the settings.
- **Several macros at once** — a switch per macro says which ones **Run**
  starts, and they run side by side, interleaving a step at a time over the one
  pointer and keyboard.
- **Pause and continue** — halting a run remembers the step it was on, and
  selecting a step is what says where the next run starts.
- **Record straight into a loop body** — click the row a recording should land
  on, and watch it go red while the recording runs. The same selection is where
  a run continues from: one mark for “here”.
- **Macros that drive each other** — a `start` step restarts a macro from the
  top *or from any step you pick*, so a watcher can send another macro straight
  to the part that matters; `stop` ends one.
- **See what a check is looking at** — a **Flash** toggle on either screen
  check draws a green outline over the checked area for a second every time it
  runs, drawn just after the screen is read so it is never part of what was
  measured or of the picture the model sees. Picking an area flashes it back at
  you too, so the numbers that land in the field are never taken on trust.
- **Emergency stop** that aborts mid-macro and releases every held key.
- **Triggers** — a mouse button or key the daemon takes over, and what happens
  in its place: press another key (side button becomes E), or start, pause or
  stop a macro — one of them, or everything switched on, which turns a spare
  button into a physical run/stop switch. The original click is consumed, so
  the game only ever sees the replacement. Set up under *Preferences → Input →
  Triggers*. A trigger with no action set leaves its button alone, and every
  trigger falls back to being a plain button when the daemon or the extension
  is not there to act — never a dead button. Recordings skip trigger presses:
  they capture what the screen saw, not what the mouse did. The same machinery
  drives the **on event step**: put it in a macro and the run parks there until
  the button is pressed, consuming the press — `repeat forever: [on event
  side button, click …, type E]` is a side button that plays a sequence. A
  run parked on a button outranks a standing trigger on the same button.

## How it fits together

| Piece | Role |
|---|---|
| `macroclickwerk.c` | Root daemon. Grabs the real input devices, mirrors them to uinput clones, injects event trains on request, and streams observed events while recording. Always forwards real input, and only holds a grab while something is reading the clone. **No macro logic.** |
| `gnome-shell/` | The extension. Owns the macro model, the editor UI, all control flow, screenshots and the model calls. |

The split is deliberate: the daemon is the only thing that can see and synthesise
input below the compositor, and the shell is the only thing that knows where the
pointer actually is and can screenshot without a portal prompt. Because the
extension sends one step at a time, stopping a macro is immediate.

### Absolute positioning

A move to a fixed coordinate is atomic: the extension asks the compositor's own
seat to warp the pointer there — one call, exact position, no acceleration
curve involved — and verifies with `global.get_pointer()`. There is no visible
glide and nothing to configure; mouse settings are never touched.

Arriving and being *seen* to arrive are not the same thing, so a positioned
click waits 50 ms after the move before the button goes down. The compositor
moves the pointer immediately; an application under it learns where the pointer
now is on its own schedule, which for anything drawing frames is once a frame.
Press in the same millisecond as the warp and a game still holds the position
from before it — so the thing being dragged, aimed or placed goes where the
pointer *was*, which reads as the click landing in the wrong place while every
coordinate involved is correct. A person moving a mouse and clicking never gets
close to being that quick. The wait is skipped when the pointer was already
there, so a macro clicking the same button in a loop pays it once.

If a target swallows the warp (a pointer-confining grab), the extension falls
back to walking there over uinput: nudge, re-read the pointer, nudge again
until it is within a pixel. The move and the click that follows it hold the
daemon between them (`DaemonClient.exclusive`), so no other macro plays in the
middle of a measurement — the pointer being read back has to be the one the
move placed.

If the target application grabs the pointer entirely — a game with mouse-look —
the reported position never changes and absolute moves cannot land. The status
line says so rather than silently clicking the wrong place. Use `move` steps with
a relative offset for those.

## Requirements

- Linux with `uinput`, GCC, `libjson-c`, `libmicrohttpd`
- GNOME Shell 50 on Wayland
- optional: any OpenAI-compatible vision endpoint, for the `llm` condition

## Installation

```bash
./deploy.sh
```

Rebuilds and installs the daemon, rebuilds the extension, and prints what the
daemon captured. Run it as yourself — it asks for sudo only for the daemon. Then
log out and back in.

### Upgrading from Clickmate

Macroclickwerk is the project formerly named Clickmate, and the rename runs
through every identifier — service, sockets, extension UUID, settings schema —
so an old installation is a separate thing, to be removed once:

```bash
sudo systemctl disable --now clickmate
sudo rm -f /usr/local/bin/clickmate /etc/systemd/system/clickmate.service \
    /usr/lib/systemd/system-sleep/clickmate
rm -rf ~/.local/share/gnome-shell/extensions/clickmate@tbocek.github.com
```

Macros live under the settings schema, so they do not carry over on their own:
**before** removing the old extension, export them (Settings → Backup →
Export → Macros) and import the file into Macroclickwerk — the same round trip
works for settings.

The two halves separately:

### Daemon

```bash
make
sudo make install
```

`macroclickwerk.service` runs the daemon with `-a`: every keyboard and pointer is
captured automatically, so the installation works on any machine without
editing anything. A device another process holds exclusively — a key remapper's
real keyboard, say — is left to it, and the remapper's virtual output is
captured instead, which keeps recorded keystrokes matching the letters you
actually press.

To capture only specific devices instead, replace `-a` with `-n` lines:

```bash
grep '^N: Name' /proc/bus/input/devices
```

lists the names. Names rather than paths, because anything paired through a
wireless receiver gets no entry under `/dev/input/by-id` at all, and bare
`/dev/input/eventN` numbers move around between boots. `-d PATH` still works if
you prefer it. A name that matches nothing is only a warning, so an unplugged
device does not stop the rest from being captured. With a remapper in the
chain, naming devices is the safer choice — the service file shows a worked
example.

**Whatever you record from must be captured.** A keyboard-with-touchpad and a
separate mouse are two devices; with `-a` both are picked up, but if you switch
to naming devices and leave the mouse out, the daemon never sees it and nothing
it does is recorded or observed.

Devices do not have to exist when the daemon starts. `/dev/input` is watched, so
anything matching is captured when it appears and reattached when it comes back
after being unplugged. That matters more than it sounds: a wireless mouse often
pairs a second or two into boot, and a remapper upstream of macroclickwerk rebuilds
its virtual keyboard every time it is restarted. Both used to leave the daemon
running against devices that no longer existed, with nothing but a line in the
journal to say so. `journalctl -u macroclickwerk -f` shows `captured`, `reattached`
and `detached` as they happen.

The daemon takes an exclusive grab on those devices — but only while something
else is actually reading the clone, which it checks once a second by looking
for the clone's node in `/proc/*/fd`. Grabbing reroutes a device through this
process, so it never happens on faith: at boot, before any compositor is up,
nothing is grabbed and input flows directly; when the session's compositor
picks the clones up, the grabs engage; when it goes away, they let go. A
forward that fails releases its grab on the spot, and after three such
failures the device stays observe-only until it reattaches — real input
flowing twice for a moment is an annoyance, real input flowing nowhere is a
dead keyboard. The kernel also drops every grab when the process dies, so a
crash self-heals. While changing the C code, still run it from an **SSH
session or a second TTY** and wrap it in `timeout 60`, so a mistake cannot
lock you out of your own keyboard.

Shutdown and sleep are both clean. Stopping the daemon (or shutting the machine
down) releases the grabs, releases anything still held down, and destroys the
virtual devices. `make install` also drops a hook into
`/usr/lib/systemd/system-sleep/`, so just before the machine suspends, whatever
is playing is aborted and every held key released — nothing stays pressed, or
keeps playing, across a sleep the desktop never sees. The daemon itself stays
running; devices that re-enumerate on resume are re-captured by its hotplug
watch. (`SIGUSR1` to the daemon is that same stop-and-release, available from
anywhere; the sleep hook is just `systemctl kill -s SIGUSR1 macroclickwerk`.)

### Extension

```bash
cd gnome-shell
pnpm install
pnpm run build
pnpm run install     # symlinks dist/ into ~/.local/share/gnome-shell/extensions
```

Log out and back in (Wayland has no `Alt+F2 r`), then enable *Macroclickwerk*.

### A local vision model

Only needed for `llm` conditions. For example:

```bash
ollama serve
ollama pull qwen2.5vl:7b
```

then point *Preferences → Model → Endpoint* at
`http://localhost:11434/v1/chat/completions`. Preferences warns when the endpoint
is not on this machine, because every check uploads a picture of your screen to it.

Endpoint, model and timeout are global — conditions carry only the prompt, the
screen area, and what to do on a failure. Each condition is asked for a single
JSON object, `{"match": true|false, "reason": "…"}`, and `response_format:
json_object` is sent so servers that support constrained decoding enforce it
(the field is dropped automatically if the server rejects it). Small models
still wander, so the reply parser also accepts fenced JSON, `"true"` as a
string, `1`/`0`, alternate keys like `answer` or `result`, trailing chatter, and
a bare YES/NO. If a prompt misbehaves, the popup's status line shows what the
model actually said.

Reasoning models get `chat_template_kwargs: {enable_thinking: false}`, because a
model that deliberates over every screenshot answers seconds late — or, once its
token budget runs out mid-thought, not at all. Templates that do not know the
field ignore it, and a server that rejects it is retried without it. Thinking
that arrives anyway is dropped: it is prose full of braces and the words *true*
and *no*, and reading a verdict out of half a thought would be worse than
reporting that none was found.

## Usage

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+F5` | Emergency stop |
| `Ctrl+Shift+F6` | Run the macros that are switched on / pause them / continue |
| `Ctrl+Shift+R` | Start / stop recording into the selected macro |
| `Ctrl+Shift+M` | Capture one click or move, appended to the selected macro |

The panel popup holds only a run switch, a **Stop**, what is running, and a
**Settings** button. It is also where progress shows up: the current step, the
last condition verdict, "Recorded 3 steps". That text is kept after the fact,
because most of it happens while the menu is closed — click the panel icon to
read it. Everything else — macros, steps, conditions, which macros run — lives
in the preferences window.

### Switched on, and running several at once

Each macro has a switch next to its name in the editor, and **Run** starts every
macro that is switched on — all of them, at the same time. They are independent:
each keeps its own place in its own steps, and one finishing or failing does not
touch the others. What they share is the machine, so their steps interleave,
taking turns at the pointer and keyboard one step each. A step is the unit: a
click at a fixed position holds the pointer for the whole move *and* the click
at the end of it, so no other macro can land a nudge in the middle and leave it
clicking somewhere else. Two macros both moving the mouse still take it in turns
and will end up somewhere neither meant; two watching different corners of the
screen and clicking different buttons will not.

Beside the switch is a **▶** that runs that one macro, on or off, right now —
and turns into a **■** while it runs, which is also how the editor shows you
which macros are going without your having to look at the panel.

A macro that is switched off is still yours to edit, record into and step
through; it just does not join in when you press Run.

The macro is the only thing there is a switch for. Steps have none: a step that
is in a macro runs when that macro runs. Something you want out of the way for
now is either deleted or put behind an `if` that says when it applies. (Steps
used to carry a switch each; documents saved with one lose it on first load, and
those steps run.)

Macros can also drive each other. A `start` step names a macro and starts it; if
that macro is already going it is stopped first and begins again, which is the
whole point — a watcher that notices the screen has gone back to its starting
state can put the macro that works it back at the beginning. An **At step**
dropdown on the same step picks where that new run begins: **From the top**, or
any step of the target macro, shown indented the way the editor nests them. A
`start` pointing into its own macro is therefore a jump — stop whatever this
run is doing, continue from the chosen step. A `stop` step names a macro and
ends it. Both offer **This macro** as the first choice, so a `start` with
nothing named is "go round again" and a `stop` with nothing named ends the run
it is in, the way a `break` ends a loop. Delete a macro or a step something
points at and the reference falls back — the macro to meaning this one, the
step to the top — rather than pinning the run to something that is gone.

### Pause, continue, stop

`Ctrl+Shift+F6` — and the switch in the popup — starts the macros that are
switched on, and halts running ones. With one macro running, halting writes down
the step it was on, so the switch reads **Continue** and the next press picks up
there rather than at the top. Several at once are in several places and there is
only one mark, so rather than be wrong about which, the next press starts them
all from the top. **Stop** in the popup, and the emergency shortcut, throw the
place away too.

You can also choose the step yourself: select it. The selected row is the one
mark the editor has — a recording lands there, and a run starts there — so
picking up in the middle of a macro is the same gesture as recording into the
middle of one. There is one selection across the whole page, in whichever macro
you last clicked; that macro is the one recordings go into, and the one that
starts at the selected step. Only a step counts for running; selecting a body,
or the end of a macro, starts at the top, and so do the other macros. A run that
fails selects the step that failed, so you can fix it and press the shortcut
again instead of replaying everything before it, and a run that reaches the end
puts the selection back at the end of its own macro.

The mark is taken at face value: continuing into the `then` or `else` of a
condition runs that branch without asking the condition again, since asking
could send the run down the other one and skip the very step you picked. A loop
you continue into is only shortened for that one pass — the next time round it
runs its whole body.

Separately from all this, while a macro is running, opening the menu and putting
the pointer on it holds the run between steps — otherwise a macro clicking at
fixed coordinates could click its own menu. It carries on as soon as you move
off the menu or close it.

Build a macro by recording it (`Ctrl+Shift+R`), then open Settings to adjust it.
Recorded steps go on the row you selected. Click any row in any macro and it is
tinted to show it: a step, and the recording is dropped in right after it; an
**Add step here** row inside a loop, or a **Yes** or **No** header, and the
recording goes at the end of that
body. Selecting nothing leaves **The end of the macro**, which is where a
recording goes by default. Choose the body of a loop and a recording lands inside
the loop instead of after it — which is what you want in a macro that is one
endless loop, and until now meant recording at the end and moving every step in
by hand. Appending to the end of a macro that never gets there still tells you
so; a body has no such trap.

While a recording is running, the selected row turns a stronger red, so you can
see where the next click will land without looking at the panel.

Recording always resumes from wherever the macro already leaves the pointer.
Between two sessions the mouse gets used for other things, and moving it back to
that spot is not a step worth keeping, so it is not recorded. Anywhere else is,
at its true screen position — coordinates are never shifted.

An `if` draws its **No** block above its **Yes** block. The failure case is the
one you go looking for — the branch that says what happens when the screen is not
what you hoped — and putting it first means it is not buried under a `then` that
has grown. It changes nothing about the run: the condition is still asked once
and the matching branch still runs.

Steps are added from the **Add step…** dropdown, which is also the button:
picking a kind adds it there, at the end of whichever list the dropdown sits in.
The row it sits on is the last row of that list, under the steps, because that is
where what it adds appears.
Next to it, **Record…** offers two ways in. **One step** captures a single
action, which is the quickest way to fill in coordinates: the window gets out
of the way, and the next click you make becomes a `click` step at that
position; move the pointer and hold still for about a second instead and you
get a `move` step. **Multiple steps** starts a whole recording landing at that
same row — the window stays out of the way until you stop (`Ctrl+Shift+R`, the
panel menu, or picking **Multiple steps** again). `Ctrl+Shift+M` captures one
step without opening Settings, into whichever row is selected.

The **▶** on a step does that one step immediately, on the real screen: the
window drops out of the way, the step runs, and the window comes back. It is the
quickest way to check that a click really lands where you meant it to, without
running the macro around it. Steps that only mean something inside a run do not
get one — a loop or an `if` would take its whole body along, and an endless loop
would take the session with it from a window that has no Stop. A step that ran
becomes the selected row, so the insertion point walks down the macro with you:
whatever you record next carries on from where you got to, rather than from
wherever the selection started out.

**Move up** and **Move down** treat the editor as what you see. A folded loop is
one card, so a step passes it in a single press; an open one is a place with an
inside, so the same press moves the step into it — in at the top coming down, in
at the bottom coming up. An `if` is entered by the side you arrive from, in the
order the two blocks are drawn: **No** from above, **Yes** from below, skipping
either if it is folded shut. Pressing on
past the end of a body climbs back out around the loop, so nothing that moved in
is stuck there.

Coordinates are single fields — `100, 200` for a point, `10, 20, 40, 40` for an
area — each with a **Show** button that flashes a red X (or an outline) at that
spot on the real screen for a couple of seconds, so you can check a number
without running anything. Next to it, **Pick** fills the field by pointing: the
window gets out of the way, the screen dims, and where you click lands in the
field — which is how you correct a coordinate that has moved without recording
the step again. Escape leaves the field as it was, and what was picked is
flashed back at you. A step's title follows its coordinates, so a click that now
goes somewhere else says where. An area is picked by dragging one out on the
same overlay, described with the condition it belongs to below.

Every one of these — the picker, the red X, the green flash — is drawn above
*everything*, fullscreen windows included. That is worth stating because it is
where the interesting applications are, and getting it takes two separate
things. A game running fullscreen sits in the shell's top window group, above
ordinary desktop chrome, so anything drawn the ordinary way is drawn behind it.
And a fullscreen window that has a monitor to itself is handed straight to the
display with no compositing pass at all, so even something stacked above it is
not drawn — the compositor has to be asked to keep compositing for as long as
the marker is up, which is what the shell's own on-screen chrome does.

Picking a position asks the compositor for the click rather than asking where
the pointer is, for the same reason: an application that holds the pointer —
any game with mouse-look — has frozen it somewhere of its own choosing, and the
picker takes the grab back before asking. A macro that *runs* has no such
luxury: it has to drive the real pointer to the coordinate, so a step aimed at
a fixed position fails outright against a game that has the pointer locked
rather than clicking wherever it got stuck. Relative motion still works there,
because relative motion is exactly what a locked pointer accepts.

Where a click or a move goes is one row: the numbers, **Pick**, **Show**, and
buttons for not using coordinates at all. On a click the mouse button means
"wherever the pointer already is", and the numbers go away with it; on a move
it means "by this much" rather than "to here", and the numbers stay but stop
being a place — so **Pick** and **Show**, which are about a spot on the screen,
go instead. It used to be a dropdown naming the mode with the coordinates on a
second row underneath: a line of prose and a line of numbers to say one thing.

The history button on the same row is "@ previous": the step goes back to
wherever the pointer was before the last positioned step in the run. Every
positioned click and move remembers the spot it left, so *click at 3438,549*
followed by *click left @ previous* is an excursion and its undo — the macro
reaches over, clicks, and puts the pointer back where you were working, in a
blink, since positioned moves are instant warps. A "@ previous" before any
positioned step has nowhere to go and stays put; each run starts with no
history.

Screen areas for `llm` conditions can also be chosen with **Pick**, which drops
the window out of the way and lets you drag a rectangle over the screen;
**Screen** goes back to checking the whole screen. Whatever you drag out is
flashed back at you once the window returns, so the numbers in the field never
have to be taken on trust.

A colour condition's **Pick** is the same overlay, and it brings the colour
back with it: click a pixel and the check is that pixel and the colour it has;
drag a rectangle and the check is that area and what it averages to.

The check is then one colour against one colour — what that area averages to
now, against what it averaged to when you picked it, within the tolerance
beside the field. There is no third number, and there used to be: a share of
the pixels that had to match. It is gone because it asked individual pixels to
match an *average*, and an average is a colour that need not be anywhere in the
area — a green button with a dark glyph on it and a white badge under it
averages to a green that is neither the button nor the glyph nor the badge, so
the share was routinely zero and the check could not come true however the
screen looked. Averaging both sides asks a question the numbers can answer, and
one number is left to tune.

Tolerance is a distance in RGB, not a slack per channel: 30 is roughly 17 per
channel if all three move together. Generous enough for antialiasing, a shadow,
a frame caught mid-animation; nowhere near enough to survive the thing you are
watching disappearing.

**Read** beside the colour takes that average again without moving the area,
for when the button you are watching has changed shade since you picked it.

`#22aa33` is a number, and a number is not a colour anyone recognises, so a
block of it sits beside the field — following the text as you type it, and
drawn as an empty outline while what you have typed is not a colour yet. The
same block follows every colour a summary line names, so a folded `If avg of
40×40 @ 1,2 ≈ #123456 ±30` says which blue it means without being opened.

The **Flash** toggle on the area row draws a green outline over the checked
area for a second every time the check runs, so you can watch a running macro
look where you meant it to. Both checks have one. The flash fires just after
the screen is read, never before: the outline's own green would otherwise be
part of the colour the check measured, and part of the picture the model is
asked about.

At the top of the Macros page, **Backup** has an **Export** and an **Import**,
each offering **Macros** or **Settings** — two files, because they move for
different reasons: the steps are the work, the settings are the machine they run
on. Both open a file chooser, so where a backup goes and which one comes back is
yours to say; the names `macroclickwerk-macros.json` and `macroclickwerk-settings.json` are
only what the save dialog starts with. Importing macros replaces every macro you
have. Importing settings skips anything the schema does not know or will not
take, and says which keys it ignored.

### Daemon HTTP API

Over the unix socket at `/var/run/macroclickwerk-socket`. One thing to know before
driving it directly: the daemon speaks raw evdev, and its virtual mouse is a
**relative** device — pointer motion through `/play` is `REL_X`/`REL_Y`, with
the compositor's acceleration curve applied to whatever you send. Absolute
positioning ("click at x,y", "@ previous") is the extension's work: it warps
the compositor's pointer, verifies where it landed, and only then clicks
through the daemon. The raw API has no such convergence — a delta in means an
accelerated delta out.

```bash
curl --unix-socket /var/run/macroclickwerk-socket http://localhost/status

# left click: press, then release 50 ms later
curl --unix-socket /var/run/macroclickwerk-socket -X POST \
  -d '{"events":[{"dt":0,"type":1,"code":272,"value":1},{"dt":50000,"type":1,"code":272,"value":0}]}' \
  http://localhost/play

curl --unix-socket /var/run/macroclickwerk-socket -X POST -d '{"on":true}'  http://localhost/record
curl --unix-socket /var/run/macroclickwerk-socket -X POST -d '{}'           http://localhost/stop
```

### Checking what is captured

`/status` lists the captured devices. To see which of them actually produce
anything, turn recording on and read the event stream directly — no shell
extension involved (`socat` works too, if you have it):

```bash
curl --unix-socket /var/run/macroclickwerk-socket -X POST -d '{"on":true}' http://localhost/record
python3 -c "
import socket; s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.connect('/var/run/macroclickwerk-events')
[print(s.recv(4096).decode(), end='') for _ in range(20)]"
curl --unix-socket /var/run/macroclickwerk-socket -X POST -d '{"on":false}' http://localhost/record
```

If a device produces nothing here, nothing above the daemon can see it either.
With `-a` that means it did not look like a keyboard or pointer, or something
else holds it exclusively — name it in `macroclickwerk.service` with `-n "<its
name>"` to insist.

`dt` is microseconds to wait *before* the event; `type`/`code`/`value` are raw
evdev. `/play` answers once the train has finished playing. `/stop` aborts it and
releases anything still held down.

## Development

```bash
cd gnome-shell
pnpm run dev      # rebuild on change
pnpm test         # build, then run the logic smoke tests under gjs
journalctl -f -o cat /usr/bin/gnome-shell
```

`./run.sh` starts a nested shell, useful for UI work only: injected uinput events
go to the *host* session, so end-to-end runs must be tested in the real session.
Cross-check injected input with `sudo libinput debug-events` and `sudo evtest`.

### Known limits

- The control socket is mode 0666, so any local process can synthesise input
  through it. Fine for a single-user desktop; tighten it with a `RuntimeDirectory`
  and a dedicated group if that matters to you.
- `type text` assumes a US keyboard layout. For other layouts, record the typing.
- X11 is not supported.

## Uninstallation

```bash
sudo make uninstall
rm ~/.local/share/gnome-shell/extensions/macroclickwerk@tbocek.github.com
```

### Resolving a boot delay

A boot delay after installing is usually `systemd-udev-settle.service`. It is
deprecated; mask it:

```bash
systemctl mask systemd-udev-settle.service
```

## Troubleshooting

- **Popup says it cannot reach the daemon** — `systemctl status macroclickwerk`, and
  check the socket path in *Preferences → Input*.
- **"The macroclickwerk daemon is out of date"** — the extension needs API v2; rerun
  `sudo make install`.
- **Clicks land in the wrong place** — check whether the target grabs the
  pointer (see *Absolute positioning*); the status line reports a move that
  could not land.
- **Daemon will not start** — check permissions on `/dev/uinput` and that
  `libjson-c` and `libmicrohttpd` are installed.

## Contributing

Contributions are welcome! Please fork the repository, make your changes, and
submit a pull request.

## Related links

- https://www.kernel.org/doc/html/v4.12/input/uinput.html
- https://stackoverflow.com/questions/20943322/accessing-keys-from-linux-input-device
