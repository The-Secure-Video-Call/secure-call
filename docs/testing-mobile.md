# Manual test checklist: iOS Safari and Android Chrome

Run this on real phones before ticking the fifth M3 box in PLAN.md ("Mobile layout and testing on
iOS Safari and Android Chrome"). Automated tests cover the pure logic only (choosing the next
camera, the "Tap to start audio" decision, `replaceTrack` on the video sender); layout, prompts
and OS behaviour can only be checked by hand.

**Devices:** one iPhone (Safari, current iOS) and one Android phone (Chrome), plus a laptop as the
other person. Run every section once per phone. Record the OS and browser version, and mark each
line Pass / Fail with a short note.

**Setup:** open the deployed (HTTPS) app. Camera access needs HTTPS, so use the staging or
production site, not a plain `http://` LAN address.

## 1. Lobby and permission prompts

- [ ] Opening the app shows the camera and microphone prompt (it appears once; no second prompt).
- [ ] Deny, then check the error message tells you to allow access in settings. Allow it and reload.
- [ ] The preview is visible, muted (no echo), and not mirrored wrongly or stretched.
- [ ] No horizontal scrolling at 360–430 px wide, portrait and landscape.
- [ ] Content stays clear of the notch and home bar (rotate to landscape on a notched phone).
- [ ] Every button and the dropdowns are easy to hit (at least 44×44 px).
- [ ] "New call" and "Copy link" work; the copied link opens the call on the laptop.

## 2. Portrait call

- [ ] Open the link from the laptop and the phone. The call connects and shows "Connected".
- [ ] The other person's video fills the screen; your own video is a small corner preview.
- [ ] The safety-code question fits the screen with **Yes** and **No** both visible (scroll the
      panel if needed). Emoji and "Show as numbers" both fit.
- [ ] After "Yes", "Verified" shows. (Also try "No" once in a separate call: the call ends with
      the warning.)
- [ ] Mute, Camera off and Hang up work; the laptop sees the changes.
- [ ] **iOS:** audio from the laptop is heard. If "Tap to start audio" appears, tapping it starts
      the sound and the button goes away.
- [ ] Nothing is cut off by the notch or home bar.

## 3. Landscape call

- [ ] Rotate to landscape mid-call: the call keeps running, the video resizes, controls move to
      the side, nothing scrolls sideways.
- [ ] The safety-code panel (start a new call to see it) still shows Yes and No in landscape.
- [ ] Rotate back to portrait: layout recovers.

## 4. Switch camera

- [ ] "Switch camera" shows on phones with more than one camera, and is **not** shown on a
      device with a single camera (for example, the laptop).
- [ ] Tapping it switches front/back; your corner preview and the laptop's view of you change.
- [ ] The call is **not** interrupted and the "Verified" mark stays (no renegotiation).
- [ ] With "Camera off" turned on, switching keeps the camera off.
- [ ] Switch several times in a row; it keeps working. Mute state is unchanged.
- [ ] If switching fails, an error is shown and your camera still works afterwards.

## 5. Lock the screen and come back

- [ ] Lock for ~10 seconds, unlock, return to the browser: note what happens (call continues,
      reconnects, or ends with a clear message). The call must never show "Verified" for a
      connection that was re-made without a new safety-code check.
- [ ] Switch to another app for ~30 seconds and back: same observations.
- [ ] Your camera and microphone work again after returning (the laptop sees and hears you).
- [ ] Hang up: the camera indicator on the phone turns off.

## 6. Wi-Fi ↔ mobile data (the M3 demo)

- [ ] Start a call between the laptop (Wi-Fi) and the phone on mobile data. It connects.
- [ ] Switch the phone from mobile data to Wi-Fi mid-call, then back. Note whether the call
      recovers and how long it takes (depends on the reconnect work in M3).
- [ ] Both people can still see and hear each other afterwards.

## 7. Privacy mode (once #48 exists)

- [ ] Turn privacy mode on, on the phone, and connect over mobile data. The call connects.
- [ ] The privacy mode toggle is reachable and at least 44×44 px.

## Report back

Reply on issue #51 with, per phone: OS and browser version, the lines that failed, and
screenshots of any layout problem. Only when every line passes (or the owner accepts the
exceptions) should the fifth M3 box in PLAN.md be ticked.
