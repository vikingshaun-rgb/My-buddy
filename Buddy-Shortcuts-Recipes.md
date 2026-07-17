# Buddy — Apple Shortcuts Recipes (Hands-Free, Confirm-Gated)

*Build these in the iPhone **Shortcuts** app once Buddy's brain is deployed and live. They make Buddy hands-free — you speak, Buddy answers/acts, and for anything risky it asks you to confirm first.*

**Before you start, you need two things (from Buddy's Settings):**
- **Brain URL:** `https://my-buddy-xu2x.onrender.com`
- **Your token:** (the same one in the app's Settings)

---

## The design principle: hands-free, but gated

- **Safe/read-only actions** (ask a question, get directions, price check) → run instantly, no confirm needed
- **Acting actions** (send a text, start a call, order food) → Buddy repeats it back and **asks "shall I?"** before doing it — you say yes/no

This is what makes hands-free safe. You never accidentally text the wrong person or order $50 of food.

---

## RECIPE 1 — "Ask Buddy" (the main one)

*Say anything, Buddy answers aloud. Read-only, so no confirm needed.*

In Shortcuts → **+** → add these actions in order:
1. **Dictate Text** (set Language to English)
2. **Get Contents of URL**
   - URL: `https://my-buddy-xu2x.onrender.com/chat`
   - Method: **POST**
   - Headers: add one → Key: `x-buddy-token` (or whatever your app uses), Value: *your token*
   - Request Body: **JSON**
     - Add field → Key: `message`, Type: Text, Value: **Dictated Text** (the variable from step 1)
3. **Get Dictionary Value**
   - Key: `reply`
   - Dictionary: **Contents of URL**
4. **Speak Text**
   - Text: **Dictionary Value**

Name it **"Ask Buddy"**. Now say **"Hey Siri, Ask Buddy"** → speak → hear the answer.

---

## RECIPE 2 — "Take me to..." (hands-free navigation, confirm-gated)

*Say a place, Buddy confirms, then starts Maps navigation hands-free.*

1. **Dictate Text** ("where do you want to go?")
2. **Show Alert** (the confirm gate)
   - Title: "Navigate there?"
   - Message: **Dictated Text**
   - Show Cancel: ON
   *(If you tap/say Cancel, the Shortcut stops here.)*
3. **Get Directions** (Apple's built-in Maps action)
   - Destination: **Dictated Text**
4. **Show Directions** — this opens Maps **already navigating** (no "Start" tap needed)

Name it **"Take Me To"**. Say **"Hey Siri, Take Me To"** → say the place → confirm → Maps navigates, voice in your glasses.

*This is the fully hands-free navigation — no "Start" tap, because Apple's Shortcut Maps action launches straight into navigation.*

---

## RECIPE 3 — "Tell my wife" (confirm-gated message)

*Send your partner a message hands-free, but Buddy confirms first.*

1. **Dictate Text** ("what's the message?")
2. **Show Alert** (confirm gate)
   - Title: "Send this to [wife]?"
   - Message: **Dictated Text**
   - Show Cancel: ON
3. **Get Contents of URL**
   - URL: `https://my-buddy-xu2x.onrender.com/share`
   - Method: POST
   - Headers: your token
   - Body JSON: `code` = your trip code, `name` = your name, `message` = **Dictated Text**
4. **Speak Text**: "Sent."

Name it **"Tell My Wife"**.

---

## How to trigger them hands-free (pick your favourite)

All of these work through your Ray-Bans (they're your Bluetooth mic + speaker):

1. **"Hey Siri, [shortcut name]"** — the simplest, no setup. Say "Hey Siri, Ask Buddy."
2. **Back Tap** — Settings → Accessibility → Touch → Back Tap → Double Tap → pick the shortcut. Now double-tap the back of your phone (in your pocket) → it runs.
3. **Action Button** (iPhone 15 Pro+) — Settings → Action Button → Shortcut → pick it.
4. **Lock Screen / Home Screen** — add the shortcut as a widget/icon for a one-tap launch.

**Best hands-free combo:** "Hey Siri, Ask Buddy" for questions; Back Tap → "Take Me To" for navigation.

---

## The honest limits (so nothing surprises you)

- **The confirm gate uses "Show Alert"** — on the glasses you'll hear the confirm and can tap, but a fully *spoken* "yes/no" confirm needs the Alert's Cancel/OK (a tap) unless you use Siri's built-in confirm. For truly spoken confirmation, keep the messages/calls ones as "Buddy reads it back, you glance + tap OK."
- **Navigation (Recipe 2) is the most hands-free** — Apple's Maps actions genuinely start navigation with no extra tap.
- **These call Buddy's brain**, so the brain must be deployed and awake. On the free Render tier the first call after idle takes ~50s (upgrade removes this).
- **Shortcuts can't read other apps' notifications** or press buttons inside Grab/WhatsApp — same Apple walls as the web app.

---

## RECIPE 4 — "Grab Dinner" (Siri announces, then hands to Buddy)

*Siri says a line, then Buddy finds food and offers Grab. The "announce → Buddy" pattern.*

1. **Speak Text** — "Let's find you something good to eat" *(your announcement / motivation line — write whatever you like)*
2. **Dictate Text** — ("what are you craving?")
3. **Get Contents of URL**
   - URL: `https://my-buddy-xu2x.onrender.com/findfood`
   - Method: POST, Headers: your token
   - Body JSON: `craving` = **Dictated Text**, `city` = your city (or leave blank)
4. **Get Dictionary Value** → Key: `spoken` → Dictionary: Contents of URL
5. **Speak Text** → **Dictionary Value** (Buddy reads the top pick + price/rating/ETA)
6. **Show Alert** (confirm gate) — Title: "Open Grab to order?", Show Cancel: ON
7. **URL** → `https://food.grab.com/`
8. **Open URLs**

Name it **"Grab Dinner"**. Say **"Hey Siri, Grab Dinner"** → it announces → asks what you want → reads options → confirms → opens Grab.

**Make it automatic (optional):** In Shortcuts → **Automation** tab → **+** → Time of Day (e.g. 6:00 PM) or Arrive (a location) → run "Grab Dinner". Now Siri announces dinner on its own. *(iOS may ask you to confirm the first time an automation runs an action — Apple's rule.)*

---

## RECIPE 5 — "Navigate (Google Maps)"

*Apple Shortcuts has no native Google Maps action, so use its URL scheme.*

1. **Dictate Text** — ("where to?")
2. **Text** action — type: `comgooglemaps://?daddr=` then insert **Dictated Text**, then `&directionsmode=walking`
   - (change `walking` to `driving`/`transit`/`bicycling` as you like)
3. **URL** — set to the Text from step 2
4. **Open URLs**

Name it **"Navigate"**. Say **"Hey Siri, Navigate"** → say the place → Google Maps opens navigating. *(Requires the Google Maps app installed. For Apple Maps instead, use Recipe 2.)*

---

## Recommended setup order

1. Deploy Buddy's brain (Phase 0) — Shortcuts need it live
2. Build **Recipe 1 (Ask Buddy)** first — test "Hey Siri, Ask Buddy, what time is it in Tokyo"
3. Add **Recipe 2 (Take Me To)** — the hands-free navigation
4. Add **Recipe 3 (Tell My Wife)** if you want gated messaging
5. Wire **Back Tap** to Ask Buddy for the "tap pocket and talk" feel

*Keep this doc. Build the Shortcuts once the brain's live — they're the layer that makes Buddy feel hands-free everywhere.*
