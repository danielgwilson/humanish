/* Finite guest-only clipboard paste. See clipboard-protocol.md. */
#define _POSIX_C_SOURCE 200809L
#include <X11/XKBlib.h>
#include <X11/Xatom.h>
#include <X11/Xlib.h>
#include <X11/extensions/XTest.h>
#include <X11/keysym.h>
#include <errno.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <unistd.h>

enum { MAX_TEXT = 65536, MAX_EVENTS = 4096, MAX_REQUESTS = 256 };
enum { BAD_FRAME = 64, BAD_X_SETUP = 65, LOST_AUTHORITY = 66,
       X_FAILURE = 67, DEADLINE = 68, CANCELLED = 69, EVENT_LIMIT = 70 };

static volatile sig_atomic_t x_failed;
static Display *display;
static Window owner, initial_focus;
static Atom clipboard, targets, utf8, timestamp;
static Time acquired;
static unsigned char text[MAX_TEXT];
static size_t text_length;
static unsigned int events_seen, requests_seen;
static int dispatched;

/* Do not flush Xlib buffers or send corrective input on any failure. */
static void fail(int code) { _exit(code); }
static void interrupted(int sig) { fail(sig == SIGALRM ? DEADLINE : CANCELLED); }
static int x_error(Display *d, XErrorEvent *e) {
  (void)d;
  (void)e;
  x_failed = 1;
  return 0;
}
static int x_io_error(Display *d) { (void)d; fail(X_FAILURE); return 0; }
static void sync_x(void) { XSync(display, False); if (x_failed) fail(X_FAILURE); }

static void arm_lifetime(void) {
  struct sigaction action;
  memset(&action, 0, sizeof(action));
  action.sa_handler = interrupted;
  sigemptyset(&action.sa_mask);
  const int signals[] = { SIGALRM, SIGTERM, SIGINT, SIGHUP, SIGPIPE };
  for (size_t i = 0; i < sizeof(signals) / sizeof(signals[0]); i++)
    if (sigaction(signals[i], &action, NULL) != 0) fail(CANCELLED);
  alarm(10);
  pid_t parent = getppid();
  if (parent <= 1 || prctl(PR_SET_PDEATHSIG, SIGTERM) != 0 || getppid() != parent)
    fail(CANCELLED);
}

static void read_exact(unsigned char *buffer, size_t length) {
  size_t offset = 0;
  while (offset < length) {
    ssize_t count = read(STDIN_FILENO, buffer + offset, length - offset);
    if (count <= 0) fail(count == 0 ? CANCELLED : BAD_FRAME);
    offset += (size_t)count;
  }
}

static int valid_utf8(const unsigned char *s, size_t length) {
  size_t i = 0;
  while (i < length) {
    uint32_t cp = s[i++], minimum = 0;
    unsigned int trailing = 0;
    if (cp == 0) return 0;
    if (cp < 0x80) continue;
    if (cp >= 0xc2 && cp <= 0xdf) { trailing = 1; minimum = 0x80; cp &= 0x1f; }
    else if (cp >= 0xe0 && cp <= 0xef) { trailing = 2; minimum = 0x800; cp &= 0x0f; }
    else if (cp >= 0xf0 && cp <= 0xf4) { trailing = 3; minimum = 0x10000; cp &= 0x07; }
    else return 0;
    if (length - i < trailing) return 0;
    for (unsigned int j = 0; j < trailing; j++) {
      unsigned char next = s[i++];
      if ((next & 0xc0) != 0x80) return 0;
      cp = (cp << 6) | (next & 0x3f);
    }
    if (cp < minimum || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return 0;
  }
  return 1;
}

/* EOF is cancellation even if a GO byte was buffered before the pipe closed. */
static int stdin_state(int allow_go) {
  struct pollfd input = { STDIN_FILENO, POLLIN, 0 };
  if (poll(&input, 1, 0) < 0) fail(CANCELLED);
  if (input.revents & (POLLHUP | POLLERR | POLLNVAL)) fail(CANCELLED);
  if (!(input.revents & POLLIN)) return 0;
  unsigned char bytes[2];
  ssize_t count = read(STDIN_FILENO, bytes, sizeof(bytes));
  if (count == 0) fail(CANCELLED);
  if (!allow_go || count != 1 || bytes[0] != 'G') fail(BAD_FRAME);
  return 1;
}

static void emit(unsigned char byte) {
  if (write(STDOUT_FILENO, &byte, 1) != 1) fail(CANCELLED);
}

static void check_authority(void) {
  int revert;
  Window focus;
  if (XGetSelectionOwner(display, clipboard) != owner) fail(LOST_AUTHORITY);
  XGetInputFocus(display, &focus, &revert);
  if (focus != initial_focus || focus == None || focus == PointerRoot || focus == owner)
    fail(LOST_AUTHORITY);
  sync_x();
}

static void selection_request(const XSelectionRequestEvent *request) {
  if (++requests_seen > MAX_REQUESTS) fail(EVENT_LIMIT);
  if (request->send_event || request->owner != owner || request->selection != clipboard)
    fail(LOST_AUTHORITY);
  check_authority();
  Atom property = request->property == None ? request->target : request->property;
  int payload = 0;
  /* X timestamps wrap at 32 bits. CurrentTime is permitted by XConvertSelection. */
  int current = request->time == CurrentTime ||
    (int32_t)((uint32_t)request->time - (uint32_t)acquired) >= 0;
  if (!current) property = None;
  else if (request->target == targets) {
    Atom supported[] = { targets, utf8, timestamp };
    XChangeProperty(display, request->requestor, property, XA_ATOM, 32,
                    PropModeReplace, (unsigned char *)supported, 3);
  } else if (request->target == timestamp) {
    XChangeProperty(display, request->requestor, property, XA_INTEGER, 32,
                    PropModeReplace, (unsigned char *)&acquired, 1);
  } else if (request->target == utf8 && dispatched) {
    XChangeProperty(display, request->requestor, property, utf8, 8,
                    PropModeReplace, text, (int)text_length);
    payload = 1;
  } else property = None;
  /* ICCCM requires detecting a failed property store before success notification. */
  sync_x();
  XEvent reply;
  memset(&reply, 0, sizeof(reply));
  reply.xselection.type = SelectionNotify;
  reply.xselection.display = display;
  reply.xselection.requestor = request->requestor;
  reply.xselection.selection = request->selection;
  reply.xselection.target = request->target;
  reply.xselection.property = property;
  reply.xselection.time = request->time;
  if (!XSendEvent(display, request->requestor, False, 0, &reply)) fail(X_FAILURE);
  sync_x();
  if (payload) {
    (void)stdin_state(0);
    emit('D');
    /* The requestor property survives closing our connection. No later input. */
    _exit(0);
  }
}

static void drain_events(void) {
  while (XPending(display)) {
    if (++events_seen > MAX_EVENTS) fail(EVENT_LIMIT);
    XEvent event;
    XNextEvent(display, &event);
    if (event.type == SelectionClear) fail(LOST_AUTHORITY);
    if (event.type == SelectionRequest) selection_request(&event.xselectionrequest);
  }
}

static void paste(void) {
  /* Serialize the last ownership/focus check with this four-event input chord. */
  XGrabServer(display);
  sync_x();
  drain_events(); /* Requests already queued before dispatch never receive text. */
  (void)stdin_state(0);
  check_authority();
  char held[32];
  XQueryKeymap(display, held);
  for (size_t i = 0; i < sizeof(held); i++) if (held[i] != 0) fail(LOST_AUTHORITY);
  XkbStateRec state;
  if (XkbGetState(display, XkbUseCoreKbd, &state) != Success ||
      state.group != 0 || state.mods != 0 || state.latched_mods != 0 ||
      state.locked_mods != 0) fail(LOST_AUTHORITY);
  KeyCode control = XKeysymToKeycode(display, XK_Control_L);
  KeyCode v = XKeysymToKeycode(display, XK_v);
  if (!control || !v || control == v ||
      XkbKeycodeToKeysym(display, control, 0, 0) != XK_Control_L ||
      XkbKeycodeToKeysym(display, v, 0, 0) != XK_v) fail(BAD_X_SETUP);
  XModifierKeymap *modifiers = XGetModifierMapping(display);
  if (!modifiers) fail(BAD_X_SETUP);
  int control_mapped = 0;
  for (int i = 0; i < 8 * modifiers->max_keypermod; i++) {
    if (modifiers->modifiermap[i] == v) fail(BAD_X_SETUP);
    if (modifiers->modifiermap[i] == control) {
      if (i / modifiers->max_keypermod != ControlMapIndex) fail(BAD_X_SETUP);
      control_mapped = 1;
    }
  }
  XFreeModifiermap(modifiers);
  if (!control_mapped) fail(BAD_X_SETUP);
  sync_x();
  (void)stdin_state(0);
  if (!XTestFakeKeyEvent(display, control, True, CurrentTime) ||
      !XTestFakeKeyEvent(display, v, True, CurrentTime) ||
      !XTestFakeKeyEvent(display, v, False, CurrentTime) ||
      !XTestFakeKeyEvent(display, control, False, CurrentTime)) fail(X_FAILURE);
  XUngrabServer(display);
  sync_x();
  dispatched = 1;
}

int main(int argc, char **argv) {
  (void)argv;
  arm_lifetime();
  if (argc != 1) fail(BAD_FRAME);
  unsigned char header[4];
  read_exact(header, sizeof(header));
  uint32_t length = ((uint32_t)header[0] << 24) | ((uint32_t)header[1] << 16) |
                    ((uint32_t)header[2] << 8) | header[3];
  if (!length || length > MAX_TEXT) fail(BAD_FRAME);
  text_length = length;
  read_exact(text, text_length);
  if (!valid_utf8(text, text_length)) fail(BAD_FRAME);
  (void)stdin_state(0);
  XSetErrorHandler(x_error);
  XSetIOErrorHandler(x_io_error);
  display = XOpenDisplay(NULL);
  if (!display) fail(BAD_X_SETUP);
  int event_base, error_base, major, minor;
  if (!XTestQueryExtension(display, &event_base, &error_base, &major, &minor))
    fail(BAD_X_SETUP);
  long max_words = XMaxRequestSize(display);
  if (max_words <= 8 || text_length > (unsigned long)(max_words - 8) * 4)
    fail(BAD_X_SETUP);
  clipboard = XInternAtom(display, "CLIPBOARD", False);
  targets = XInternAtom(display, "TARGETS", False);
  utf8 = XInternAtom(display, "UTF8_STRING", False);
  timestamp = XInternAtom(display, "TIMESTAMP", False);
  owner = XCreateSimpleWindow(display, DefaultRootWindow(display), 0, 0, 1, 1, 0, 0, 0);
  XSelectInput(display, owner, PropertyChangeMask);
  Atom marker = XInternAtom(display, "_HUMANISH_CLIPBOARD_TIME", False);
  unsigned char value = 0;
  XChangeProperty(display, owner, marker, XA_INTEGER, 8, PropModeReplace, &value, 1);
  sync_x();
  for (;;) {
    if (++events_seen > MAX_EVENTS) fail(EVENT_LIMIT);
    XEvent event;
    XNextEvent(display, &event);
    if (event.type == PropertyNotify && event.xproperty.window == owner &&
        event.xproperty.atom == marker && !event.xproperty.send_event) {
      acquired = event.xproperty.time;
      break;
    }
  }
  int revert;
  XGetInputFocus(display, &initial_focus, &revert);
  XSetSelectionOwner(display, clipboard, owner, acquired);
  check_authority();
  (void)stdin_state(0);
  emit('R');
  for (;;) {
    drain_events();
    struct pollfd fds[2] = {
      { STDIN_FILENO, POLLIN, 0 }, { ConnectionNumber(display), POLLIN, 0 }
    };
    if (poll(fds, 2, -1) < 0) fail(CANCELLED);
    if (fds[1].revents & (POLLHUP | POLLERR | POLLNVAL)) fail(X_FAILURE);
    drain_events();
    if (stdin_state(dispatched ? 0 : 1)) paste();
  }
}
