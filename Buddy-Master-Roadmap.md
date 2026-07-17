# My Buddy — Master Architecture & Phased Roadmap

*The single source of truth for how Buddy, Meta glasses, and Apple Shortcuts fit together — and the order to build/fix things without breaking what works.*

---

## The Core Idea: Three Layers, Each Doing What It's Best At

Buddy isn't one app — it's a **brain** that three different "faces" talk to. The trick is letting each face do only what it's good at.

| Layer | Role | What it does best |
|---|---|---|
| **Buddy brain** (server.js on Render) | The intelligence | Thinks, translates, plans, searches, remembers, reads your inbox |
| **Buddy web app** (app.html) | The hands | Chat, tiles, launches other apps, shows results |
| **Apple Shortcuts / Siri** | The voice trigger | "Hey Siri, ask Buddy…" — hands-free without the glasses |
| **Meta glasses** (native, later) | The eyes + ears | Live camera, always-on voice, hands-free everything |

**Everything routes through the one brain.** The web app, a Siri Shortcut, and (later) the glasses all call the *same* endpoints. Build a feature once in the brain → every face can use it.

---

## The Honest Limits (why the "grind" happens) — and the workarounds

The web app hits a wall whenever it tries to **control or read another app**. Apple forbids it. But there are two things the web app *can* always do, and leaning into them is how Buddy gets good:

1. **Launch other apps with something pre-filled** (deep-links)
2. **Read anything that arrives in your inbox** (email + SMS-over-email)

| What you want | Web app | Workaround that actually works |
|---|---|---|
| Camera on voice command | ❌ blocked | **Meta glasses** (native) |
| Control Apple Music playback | ❌ blocked | ✅ deep-link to open a song/playlist |
| Read Messenger / WhatsApp | ❌ blocked | ✅ deep-link to *start* a message |
| Read Grab / app notifications | ❌ blocked (iOS sandbox) | ✅ read the SMS/email version from inbox |
| Live driver tracking | ❌ Grab-only | ✅ read Grab's update texts/emails aloud |
| Google/Apple Maps directions | ⚠️ partial | ✅ deep-link with the route pre-filled |
| Always listening | ❌ blocked | **Siri Shortcut** trigger, or glasses |
| Answer phone calls | ❌ blocked | Groundwire / native / VoIP receptionist (later) |

**The rule of thumb:** if a feature is *"Buddy understands / knows / decides something"* → build it in the brain, works everywhere. If it's *"Buddy controls another app"* → it becomes a deep-link (launch) or an inbox-read, or it waits for the glasses.

---

## How Voice Control Works (the part that ties it together)

There are **three voice paths**, and they layer — each one gets you closer to hands-free:

**1. In-app voice — works now, tap-gated**
Tap 🎤 in Buddy → speak once → Buddy hears it → responds aloud.
*Limit:* not always-listening (Apple blocks continuous mic in web).

**2. Siri Shortcut voice — the bridge (build in Phase 4)**
"Hey Siri, ask Buddy [anything]" → Siri turns your speech to text → sends it to Buddy's `/chat` (or `/route`) endpoint → speaks the reply.
*This is the big unlock:* hands-free triggering **without opening the app**, before the glasses arrive. Siri becomes Buddy's wake word.

**3. Glasses voice — the endgame (Phase 6)**
Always-on mic on the Meta glasses → continuous listening → full hands-free including the camera. Speak naturally, Buddy sees and hears everything (with permission).

**They don't compete — they stack.** Siri Shortcuts make Buddy feel hands-free today; the glasses complete it.

---

## THE PHASES

Each phase is self-contained. **Do them in order. Don't start a phase until the one before it works.** This is how we stop breaking things.

### Phase 0 — Stabilise (DO THIS FIRST, before anything)
*Get the current app solid. No new features.*
- [ ] Deploy the latest `server.js` to the **My-buddy NODE service** (xu2x) — fixes the brain ("didn't catch that")
- [ ] Confirm chat answers ("what time is it?")
- [ ] Set the **Proxy URL** in app Settings → makes camera + all tiles work
- [ ] Sort the real-world email issue (revoke app-password to rule Buddy out, check iCloud storage)
- **Exit test:** chat replies, camera opens, tiles respond. *Nothing else matters until this passes.*

### Phase 1 — Core Brain Features (already built, just verify live)
*All of this is coded + audited — this phase is confirming it works once deployed.*
- Chat with memory · Vision ("what am I seeing?") · Translate · Conversation mode · Etiquette · Landmark
- Navigate · Weather · Nearby · Get-me-un-lost · Plan my day
- Scam guard · Allergy shield · Survival pack
- Money: currency · good deal · spend tracker · split bill · tip
- Smart router (one chat box → right skill)
- **Exit test:** each category's tiles return real answers.

### Phase 2 — Polish the Deep-Links (launch other apps cleanly)
*Make every "open another app" reliable. All within Apple's rules.*
- **Google Maps AND Apple Maps** directions (deep-link with route pre-filled — let user pick which)
- **Apple Music / Spotify / YouTube Music** (open a song/playlist)
- **WhatsApp / Messenger** (start a message)
- **Grab** food + ride (deep-link, pay in Grab)
- **Music moods** quick-launch
- **Exit test:** each opens the right app with the right thing loaded.

### Phase 3 — Inbox as the Notification Bridge (Buddy's superpower)
*The one thing the web app CAN do that feels magic: read your inbox.*
- Read out SMS (via TelTel email format) + reply by voice
- Read out email + reply
- **"Any update on my order?"** → scans inbox for Grab/delivery messages, reads aloud
- Future: read any service's confirmation/notification emails aloud
- **Exit test:** "read my texts" + "any update on my order?" both work.

### Phase 4 — Apple Shortcuts + Siri Voice Layer
*Hands-free triggering without the glasses.*
- "Hey Siri, ask Buddy…" Shortcut → hits `/chat` → speaks answer
- Optional automations: "when I get home → Buddy briefing", CarPlay trigger
- Bridge Shortcut for anything iOS lets Shortcuts read that the web app can't
- **Exit test:** "Hey Siri, ask Buddy what's the time in Tokyo" speaks a real answer.

### Phase 5 — Couples / Together (built, verify + extend)
*Shared trip features — the market barely does these.*
- Link with partner (trip code) · Find each other · Meet-here pins · Message relay · Shared plan
- Saved places ("home" / "beach") — GPS matched to names *(offered, not yet built)*
- **Exit test:** two devices on one trip code can see each other + share pins.

### Phase 6 — Meta Glasses (native, the endgame)
*The camera + always-on voice half. Separate build, same brain.*
- **Meta glasses = the eyes:** live camera → Buddy's vision brain (what am I seeing / landmark / translate signs)
- **Always-on "Hey Buddy" voice** → full hands-free
- **Meta AI for camera**, Buddy for the thinking — the split you wanted
- Needs: virtual Mac + Xcode + Apple Dev licence ($99/yr) + Meta Wearables toolkit + glasses
- The native app is a **thin connector** — it reuses every Buddy endpoint already built
- **Exit test:** "Hey Buddy, what am I looking at?" works hands-free through the glasses.

---

## How Meta AI + Buddy + Shortcuts Link (the integration map)

```
                         ┌─────────────────────────┐
                         │   BUDDY BRAIN (server)   │
                         │  chat, vision, translate │
                         │  food, money, inbox, etc │
                         └───────────▲─────────────┘
                                     │ (same endpoints for all)
        ┌────────────────┬───────────┼───────────┬────────────────┐
        │                │           │           │                │
  ┌─────▼─────┐   ┌──────▼─────┐ ┌───▼────┐ ┌────▼──────┐  ┌──────▼──────┐
  │ Web app   │   │ Siri /     │ │ Meta   │ │ Deep-links│  │ Inbox read  │
  │ (tiles +  │   │ Shortcuts  │ │ glasses│ │ (Maps,    │  │ (SMS/email, │
  │  chat)    │   │ "Hey Siri  │ │ camera │ │  Music,   │  │  Grab       │
  │           │   │  ask Buddy"│ │ + voice│ │  Grab)    │  │  updates)   │
  └───────────┘   └────────────┘ └────────┘ └───────────┘  └─────────────┘
```

- **Meta AI** handles the *camera capture* on the glasses, then hands the image to **Buddy's brain** to interpret.
- **Apple Shortcuts** is the *voice trigger* that calls Buddy's brain hands-free.
- **Buddy** is the constant — the brain everything else plugs into.

---

## Build Rules (so nothing breaks)

1. **One phase at a time.** Finish + test before the next.
2. **Every app.html edit → run a JS syntax check** (not just brace-count — the apostrophe bug taught us this).
3. **Every batch → full audit:** server valid, app JS valid, all tile handlers defined, braces balanced.
4. **Deploy server.js to the NODE service** (xu2x), Manual Deploy. The static site ignores server.js.
5. **Cumulative zips** — each bundle contains everything, so one deploy catches up.
6. **The brain is the asset.** Build features brain-side so web + Shortcuts + glasses all inherit them.

---

*Keep this doc. Update the checkboxes as phases complete. When starting a session, say which phase you're on.*
