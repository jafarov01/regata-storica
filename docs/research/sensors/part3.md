
### 3.3 What the phone screens draw from the snapshot

- **Pilot wheel**: rotate the wheel SVG by `-snapshot.steerAngleDeg` so its top mark stays pointing at the sky while the phone turns; fill an arc from 0 to `steer` with the dead zone (±4 deg) drawn as a thin grey band and the lock (±35 deg) as end stops. Grey the wheel and show "tilt the phone up" while `steerWeak`, and "tap CALIBRATE" while `!steerCalibrated`. The pilot looks at the wall, so the fill (not the angle) is the part they see in peripheral vision: make it the team colour, 30 vmin tall.
- **Gunner needle**: `yawSinceRecenterRad` is the phone's own estimate of aim versus bow since the last RECENTER; it ignores the sim's aim-assist gain cut (section 4 of the spec, applied in `src/sim`) and the boat's own turning, so treat it as a hint and prefer an `aimRel` field in `Hud` if the contract is extended. Show "no gyroscope, using compass" when `yawSource === 'orientation'`.
- **Engineer**: `shake` drives the bucket animation speed; the water meter comes from `Hud.water`.
- **Debug line** (`describeSensors(snapshot)`): sign in use, yaw source, shake level. Keep it on screen until Gate 1 passes.

## 4. Edge cases and how they are handled

| Case | Behaviour | Handling |
|------|-----------|----------|
| Plain http (LAN IP, no tunnel) | iOS: `requestPermission()` resolves `'denied'` and logs "Call to requestPermission() failed, reason: Browsing context is not secure." Chrome 76+: handlers never fire on insecure origins. | `requestMotionAccess()` checks `window.isSecureContext` first and returns `reason: 'insecure'` with the message "open the https link from the QR". The 1 s watchdog catches anything that slips through. |
| Desktop browser | `DeviceMotionEvent` exists but no events arrive. | Watchdog reports `'no-events'` after 1 s; with `?sim=1` the keyboard source replaces the device. |
| iOS prompt refused | WebKit caches the decision per origin in the UI process; later calls resolve `'denied'` without a prompt, across reloads. | Message tells the player to close the tab, scan again and tap Allow. |
| `requestPermission()` called outside a gesture | Rejects with `NotAllowedError` ("Requesting device motion access requires a user gesture to prompt"). | Mapped to `'needs-gesture'`: "tap Enable controls again". `enableControls()` starts fullscreen, permission and wake lock synchronously before any `await`. |
| Chrome 151+ exposes `requestPermission` | Resolves without a prompt while the default stays ALLOW. | The code calls it whenever it is a function; it is never used as a platform test. |
| `DeviceOrientationEvent.requestPermission` | WebKit keeps one state for motion and orientation and starts both listeners on grant. | Not called; one prompt. |
| No gyroscope | iOS: `rotationRate === null`. Chrome Android: an object whose `alpha/beta/gamma` are `null` (NaN internally). | `toRot()` returns null for both; `yawSource` becomes `'orientation'` and the heading fallback runs. |
| No linear-acceleration sensor | Chrome Android gives `acceleration` with null fields. | Shake uses `ag - lowpass(ag)`. |
| Tab hidden, screen locked, app switcher | The spec requires events only while the document is visible; timers are throttled; the wake lock is released. | Sender sends one neutral packet and stops; on return it resets the filters (no jump from stale state) and restarts; `WakeLockKeeper` re-requests; the watchdog gives a 1 s grace and then reports `'stalled'` with a "tap to re-enable" button that re-runs `source.start()` (no new prompt: the grant is cached). |
| iOS 16.0 to 16.3 | No `navigator.wakeLock`. | `WakeLockKeeper.supported()` false: show "turn off Auto-Lock in Settings > Display & Brightness for this round". iOS 16.4 to 18.3: works in a Safari tab, not in Home Screen web apps (we use Safari tabs from the camera QR). |
| Phone held flat | In-plane gravity vanishes; `atan2` becomes noise. | `weak` flag: steer holds, wheel greys, CALIBRATE refuses (`calibrateSteer()` returns false). |
| Landscape upside down (angle near ±180) | Wrap boundary. | `wrapDeg` keeps the difference continuous across ±180. |
| Both landscapes, both platforms | Offsets +90/-90 and a 180 shift on iOS. | Absorbed by the calibration difference; verified in `check_math.mjs` for all four combinations at pitch 0, 30, 60. |
| Pilot never taps CALIBRATE | `calibrationDeg` is null. | Steer stays 0 and the wheel shows "tap CALIBRATE"; the host can also broadcast a calibrate during the countdown through the sender's `calibrate` edge. |
| Gyro saturation / glitch samples | Consumer gyros saturate around 2000 deg/s; a glitch would throw the aim. | Rate clamped to ±600 deg/s; `dt` clamped to 100 ms, first sample uses 1/60. |
| Hand tremor and bias drift | Below 2 deg/s. | Soft dead zone removes 2 deg/s without a jump at the edge. |
| Fast swings pollute the gravity estimate | Centripetal acceleration adds to `ag`. | The yaw axis uses a slower filter (0.25 s) and the projection only needs the direction; errors are second order. |
| Aim sign reversed on a phone | Unknown sensor stack. | Persisted "Invert aim" toggle in the gunner screen, plus the sign detector; Gate 1 checklist includes the sign test. |
| `interval` field | iOS 0.01667 (seconds), Chrome 16 (ms). | Never read. |
| Two fingers on one zone | Counted per zone. | `held` is a counter; the zone releases when the last pointer leaves. |
| Finger slides from GAS into BRAKE | Would toggle both. | Zone fixed at pointerdown; pointerup is delivered to the captured element (implicit touch capture). |
| `pointercancel` (browser took the gesture, palm rejection, incoming call) | No `pointerup` arrives. | Treated as release; `touch-action: none` prevents the browser from taking the pointer in the first place. |
| Window blur / visibility hidden with a thumb down | Up event lost. | `releaseAll()` on `blur` and on hidden. |
| Double-tap zoom, pinch, long-press callout, text selection, context menu | iOS ignores `user-scalable=no`; WebKit zooms positioned elements despite `touch-action: none` (bug 218015). | `touch-action: none`, `-webkit-touch-callout: none`, `user-select: none`, non-passive `touchstart/touchmove/touchend` and `gesturestart` `preventDefault()`, `contextmenu` cancelled. |
| Pull-to-refresh, rubber band, swipe-back from the edge | Chrome and Safari gestures. | `overscroll-behavior: none` on `html, body`; `touchstart.preventDefault()` on the pads also blocks the iOS 13.4+ back-swipe when it starts on a pad. |
| Safari bottom toolbar / `100vh` | `100vh` is the largest viewport; content hides behind the bar. | `height: 100dvh` with a `100vh` fallback, `position: fixed; inset: 0`, no scrolling, `viewport-fit=cover` with `env(safe-area-inset-*)` padding for the notch in landscape. |
| Orientation detection on iOS before 16.4 | No `screen.orientation`. | `matchMedia('(orientation: landscape)')` is the fallback; `screen.orientation.type` is used when present (also tells left vs right landscape). The media query flips when the software keyboard shrinks the viewport, which only matters in the lobby where the nickname field lives. |
| Orientation lock | Safari has no `lock()`; Chrome allows it in fullscreen. | Attempted after `requestFullscreen` on Android, errors swallowed; the overlay is the real mechanism. |
| Vibration | Safari has none; Chrome returns `false` without a prior user gesture. | `haptic()` falls back to a 90/220 ms red flash on the pad root whenever `vibrate` is missing or returns false. |
| `localStorage` throws (private mode) | Toggle cannot persist. | try/catch, default off. |
| Role swap in the lobby | Different pad layout and message type. | `controller.setRole()` restarts the sender; the pipeline and sensors stay. |
| Engineer in portrait | Allowed by the spec. | The engineer screen does not show the rotate overlay; the pipeline still computes shake in any orientation. |

## 5. Day-one testing

Without phones (all three of these run from the scene PC):

1. `npm test` runs `src/phone/sensorMath.test.ts`: wrap, dead zone, curve values (19.5 deg -> 0.35, 35 -> 1.0), clockwise 20 deg -> +20 in both landscapes, iOS sign invariance, pitch invariance, weak pose, yaw projection (30 deg/s at a tilted pose, 0 when perpendicular, sign flips with `up`), yaw step (32 deg/s at 1/60 s -> 2 * 30 * pi/180 / 60 rad), 45 deg/s for 1 s -> 2 * 43 deg of view, orientation up vectors, heading continuity across beta = 90, shake peaks (refractory, re-arm, 4 peaks -> 1.0, decay), the sign detector, the low-pass step response, simulator sign conventions, and packet building (a sub-tick FIRE tap still sends `fire: true`).
2. Open `https://localhost:5173/play?room=TEST&sim=1` on the laptop (or the tunnel URL): the keyboard source runs. `A`/`D` roll the wheel (eased to ±35), `W`/`S` pitch, Left/Right arrows turn at 90 deg/s, Space shakes, `I` switches the simulated platform between Android and iOS signs (steer must not change, yaw must not change because the detector and the sign flip cancel), `N` removes the gyroscope (the yaw source switches to orientation and arrows still turn), `L` swaps landscape side (re-calibrate, steer must still be right-positive), `R` resets. The mouse drives the pads. Watch the sent packets in the console or the relay log at a steady 30 per second; switch tabs and confirm one neutral packet then silence.
3. `check_math.mjs` (scratchpad) is the independent rotation-matrix check of the formulas; keep it next to the tests if anyone changes the frames.

With phones (Gate 1, in this order; takes 10 minutes):

1. Start the relay and `npm run tunnel`; put the https URL in the QR. Open it on the iPhone with the camera app (Safari, not an in-app browser) and on the Android phone in Chrome.
2. Tap Enable controls. iPhone: the "would like to access motion and orientation" sheet must appear once; tap Allow. Android: no sheet. The debug line must show `ag=-up (iOS)` on the iPhone and `ag=+up` on Android within 2 s of holding the phone upright, and `yaw:gyro`.
3. Negative tests: open the same route over `http://<lan-ip>:5173` on both phones and confirm the "not on https" message, not a silent nothing. On the iPhone tap Don't Allow once, confirm the recovery message, close the tab, rejoin.
4. Pilot: hold landscape, tap CALIBRATE, turn the phone clockwise: the wheel fill grows to the right, the box boat on the TV turns right; 4 deg does nothing, 35 deg is full lock; lay the phone flat: the wheel greys and the boat keeps its last steer; rotate the phone to the other landscape, calibrate again, repeat.
5. Gunner: point at the screen, tap CALIBRATE, turn your body 45 deg left: the view turns 90 deg left on both phones. If one phone turns right, flip "Invert aim" and note the model; the detector log line tells whether the UA guess or the detector decided. Hold the phone pitched 30 deg down and repeat: same result (that is the projection working). Stand still for 30 s: no drift. Tap RECENTER: the view snaps to the bow.
6. FIRE: a quick tap registers once; holding auto-fires only with a weapon that allows it (sim side). Android vibrates on fire; iPhone flashes red.
7. Engineer: shake for 2 s: the water meter empties; waving slowly does nothing.
8. Lock the iPhone, unlock, return: the watchdog shows stalled for at most 1 s, then controls resume with no prompt; the wake lock re-arms (screen must not dim during a 5-minute round on both phones).
9. Rotate to portrait: overlay appears; back to landscape: it goes away. Pinch, double-tap and long-press on the pads must do nothing; swiping from the left edge on the pad must not go back.

## 6. Sources

Specs and standards

- W3C Device Orientation and Motion: frames, `accelerationIncludingGravity` example `{x: 0, y: 0, z: 9.8}` for a flat device, rotation rate in deg/s, `alpha` getter = x-axis rate, `interval` in ms, `requestPermission()` on both interfaces, `[SecureContext]`, events only while visible, nullable fields: https://w3c.github.io/deviceorientation/
- rotationRate axis mismatch resolved by changing the spec to the browsers' alpha=x, beta=y, gamma=z (issue #44, PR #43 merged 31 Jan 2019): https://github.com/w3c/deviceorientation/issues/44 and https://lists.w3.org/Archives/Public/public-geolocation/2017Aug/0001.html
- Pointer Events (implicit capture for direct-manipulation devices, `pointercancel` when the UA takes the gesture, `touch-action` is the only way to prevent that): https://www.w3.org/TR/pointerevents/

Browser engine sources (read via GitHub raw)

- WebKit `DeviceOrientationAndMotionAccessController.cpp`: one `m_accessStatePerOrigin` state for motion and orientation, no second prompt after a decision, starts both listeners on grant: https://raw.githubusercontent.com/WebKit/WebKit/main/Source/WebCore/dom/DeviceOrientationAndMotionAccessController.cpp
- WebKit `DeviceMotionEvent.cpp`: `requestPermission` resolves `denied` with "Call to requestPermission() failed, reason: ..." or rejects `NotAllowedError` "Requesting device motion access requires a user gesture to prompt"; `interval()` returns the stored value unchanged: https://raw.githubusercontent.com/WebKit/WebKit/main/Source/WebCore/dom/DeviceMotionEvent.cpp
- WebKit `LocalDOMWindow.cpp`: "Browsing context is not secure" and the Feature-Policy messages: https://raw.githubusercontent.com/WebKit/WebKit/main/Source/WebCore/page/LocalDOMWindow.cpp
- WebKit `WebCoreMotionManager.mm`: `totalAccel = userAccel + gravity`, scaled by `kGravity = 9.80665`, no negation; `rad2deg(rotationRate.x, y, z)` positionally; `nullopt` rotation when no gyroscope: https://raw.githubusercontent.com/WebKit/WebKit/main/Source/WebCore/platform/ios/WebCoreMotionManager.mm
- WebKit `WebCoreMotionManager.h`: `kMotionUpdateInterval = 1.0f / 60.0f`: https://raw.githubusercontent.com/WebKit/WebKit/main/Source/WebCore/platform/ios/WebCoreMotionManager.h
- WebKit `DeviceMotionClientIOS.mm`: `RotationRate::create(xRotationRate, yRotationRate, zRotationRate)` and `kMotionUpdateInterval` passed as the event interval: https://raw.githubusercontent.com/WebKit/WebKit/main/Source/WebCore/platform/ios/DeviceMotionClientIOS.mm
- Chromium `device_motion_event_pump.cc`: `RadToDeg(gyro.x, .y, .z)` into `Create(alpha, beta, gamma)`, accelerometer passed unnegated, NaN for missing sensors, `kDefaultPumpDelayMicroseconds / 1000` as interval: https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/modules/device_orientation/device_motion_event_pump.cc
- Chromium `device_motion_event_rotation_rate.h/.cc`: `Create(double alpha, double beta, double gamma)`, NaN -> `std::nullopt`: https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/modules/device_orientation/device_motion_event_rotation_rate.cc
- Chromium `device_sensor_event_pump.h`: `kDefaultPumpFrequencyHz = 60`: https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/modules/device_orientation/device_sensor_event_pump.h
- Chrome Intent to Ship: DeviceOrientation Events permission request API (17 June 2026, Chrome 151, no effect while the default is ALLOW): https://groups.google.com/a/chromium.org/g/blink-dev/c/ckd2rFmT3PA
- Chrome 76 deprecations: device motion and orientation restricted to secure contexts: https://developer.chrome.com/blog/chrome-76-deps-rems/

Platform behaviour

- iOS reports z = -9.81 for a flat face-up device while Android reports +9.81 (W3C list, Nov 2014): https://lists.w3.org/Archives/Public/public-geolocation/2014Nov/0001.html and https://lists.w3.org/Archives/Public/public-geolocation/2014Nov/0004.html
- Android motion sensors: stationary device reads +9.81, free fall 0, gyroscope in rad/s positive counter-clockwise: https://developer.android.com/develop/sensors-and-location/sensors/sensors_motion
- Apple CoreMotion: total acceleration = gravity + userAcceleration (device frame); rotation rate structure: https://developer.apple.com/documentation/coremotion/cmdevicemotion/gravity and https://developer.apple.com/documentation/coremotion/cmgyrodata/rotationrate
- iOS `alpha` is relative to the start, `absolute` undefined, `webkitCompassHeading` clockwise from magnetic north: https://lists.w3.org/Archives/Public/public-geolocation/2014Aug/0020.html and https://dev.to/toolswebs1/building-a-compass-in-the-browser-how-the-deviceorientation-api-actually-works-3f37
- beta = +90 for an upright phone on Chrome Android and Safari (2014 gap measurement): https://lists.w3.org/Archives/Public/public-geolocation/2014Jan/0000.html
- Safari 13 release post: Pointer Events, `DeviceMotionEvent.requestPermission()` required: https://webkit.org/blog/9674/new-webkit-features-in-safari-13/
- Permission must come from a tap and https (tutorial, 2020): https://yal.cc/js-device-motion/ ; denial cached across reloads (Apple forum): https://developer.apple.com/forums/thread/128376
- Firefox Android devicemotion interval 100 ms before Firefox 44 (bug 1217942): https://bugzilla.mozilla.org/show_bug.cgi?id=1217942
- Screen Wake Lock API: auto-release when hidden, re-request on `visibilitychange`: https://developer.mozilla.org/en-US/docs/Web/API/Screen_Wake_Lock_API ; support Chrome 84, Safari 16.4, iOS full 18.4 (16.4 partial, not in Home Screen web apps): https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/WakeLock.json
- Safari 16.4 features: Screen Wake Lock, Screen Orientation (`type`, `angle`, `change`; `lock()` experimental): https://webkit.org/blog/13966/webkit-features-in-safari-16-4/ ; `ScreenOrientation.lock` Safari: not supported, Chrome Android 38: https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/ScreenOrientation.json
- Element fullscreen on iPhone: WebKit bug 212934 (WONTFIX) and the forum thread: https://bugs.webkit.org/show_bug.cgi?id=212934 and https://developer.apple.com/forums/thread/133248?page=2
- `navigator.vibrate`: sticky activation required, no effect without hardware: https://developer.mozilla.org/en-US/docs/Web/API/Navigator/vibrate ; Chrome Android 32, returns false without a gesture since 60, Safari none: https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/Navigator.json
- `dvh`/`svh`: Safari 15.4, Chrome 108: https://raw.githubusercontent.com/mdn/browser-compat-data/main/css/types/length.json and https://webkit.org/blog/12445/new-webkit-features-in-safari-15-4/
- `overscroll-behavior` in Safari 16: https://webkit.org/blog/13152/webkit-features-in-safari-16-0/ ; disabling pull-to-refresh in Chrome: https://developer.chrome.com/blog/overscroll-behavior
- Pointer Events in Safari 13 (BCD): https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/PointerEvent.json ; `touch-action: none` Safari iOS 13, `manipulation` 9.3: https://raw.githubusercontent.com/mdn/browser-compat-data/main/css/properties/touch-action.json ; value semantics and `pointercancel` note: https://developer.mozilla.org/en-US/docs/Web/CSS/touch-action
- `touch-action: none` does not stop double-tap zoom on positioned elements (WebKit bug 218015): https://bugs.webkit.org/show_bug.cgi?id=218015 ; `user-scalable=no` ignored since iOS 10: https://frontendchecklist.io/rules/css/viewport-zoom ; `touch-action: manipulation` and the 350 ms delay: https://webkit.org/blog/5610/more-responsive-tapping-on-ios/ ; `touchstart.preventDefault()` blocks the iOS 13.4+ back-swipe: https://pqina.nl/blog/blocking-navigation-gestures-on-ios-13-4/
- Touch events: `preventDefault` on `touchstart`/first `touchmove` suppresses the compatibility mouse events; second-touch behaviour differs per browser: https://developer.mozilla.org/en-US/docs/Web/API/Touch_events
- Installed typings read: `node_modules/typescript/lib/lib.dom.d.ts` (TypeScript 5.9.3): `DeviceMotionEvent.{acceleration,accelerationIncludingGravity,rotationRate}: ... | null`, `interval: number`, `DeviceMotionEventAcceleration.x: number | null`, `DeviceMotionEventRotationRate.alpha: number | null`, no `requestPermission` static, `WakeLock.request(type?: WakeLockType): Promise<WakeLockSentinel>`, `WakeLockSentinel.released/release()`, `ScreenOrientation.type: OrientationType` with `unlock()` but no `lock()`, `Navigator.vibrate(pattern: VibratePattern): boolean`, `isSecureContext: boolean`, `PermissionState = "denied" | "granted" | "prompt"`, `FullscreenOptions.navigationUI`, `Element.setPointerCapture(pointerId)`, `pointercancel`/`lostpointercapture` in the event maps, `VisualViewport`, `DocumentVisibilityState`.
