// src/phone/controller.ts
// Wires sensors, pads, wake lock and the 30 Hz sender for one role screen.
// The lobby calls startController() from the "Enable controls" tap; the role screens
// read controller.snapshot() each animation frame for the wheel graphic and the needle.

import { PHONE } from '@shared/config';
import type { InputSample } from '@shared/protocol';
import type { Role } from '@shared/state';
import { Pads, buildPadLayout } from './pads';
import { startInputSender } from './sender';
import { tuningFromPhoneConfig } from './sensorMath';
import { KeyboardSensorSource, wantsSimulator } from './sensorSim';
import {
  ControllerPipeline,
  DeviceSensorSource,
  createMotionWatchdog,
  enableControls,
  loadInvertAim,
  type ControllerSnapshot,
  type EnableControlsResult,
  type MotionHealth,
  type SensorSource,
} from './sensors';
import { WakeLockKeeper, requestFullscreenLandscape, watchOrientation } from './wake';

export interface PhoneController {
  readonly enable: EnableControlsResult;
  readonly pipeline: ControllerPipeline;
  readonly pads: Pads;
  readonly padsRoot: HTMLElement;
  snapshot(): ControllerSnapshot;
  setRole(role: Role, gunnerHasPowers: boolean): void;
  /** While true the sender coasts (rotate-your-phone overlay up): no steer, no aim, no taps. */
  setSuspended(on: boolean): void;
  /** After a 'stalled' health report: re-arms the listeners without a new prompt. */
  restartSensors(): void;
  dispose(): void;
}

export interface PhoneControllerDeps {
  readonly role: Role;
  /** Teams of 2: the Gunner also gets the two power buttons. */
  readonly gunnerHasPowers: boolean;
  readonly mount: HTMLElement;
  /** Usually PhoneClient.sendInput (src/net/client.ts), which adds `seq`. */
  readonly send: (sample: InputSample) => void;
  readonly onHealth: (health: MotionHealth) => void;
  readonly onOrientation: (landscape: boolean) => void;
  /** Send { t: 'calibrate' } to the scene when ok. */
  readonly onCalibrate?: (ok: boolean) => void;
}

/** Must be called synchronously from the pointerup/click handler of "Enable controls". */
export async function startController(deps: PhoneControllerDeps): Promise<PhoneController> {
  const wake = new WakeLockKeeper();
  const sim = wantsSimulator();
  // ?sim=1 (desktop testing): no motion prompt; desktop Chromium may never answer it.
  const enable: EnableControlsResult = sim
    ? { motion: { ok: true, prompted: false }, wakeLock: await wake.request(), fullscreen: false }
    : await enableControls({
        requestWakeLock: () => wake.request(),
        requestFullscreen: () => requestFullscreenLandscape(),
      });

  const source: SensorSource = sim ? new KeyboardSensorSource() : new DeviceSensorSource();
  const tuning = tuningFromPhoneConfig(PHONE);
  const pipeline = new ControllerPipeline({ tuning, invertAim: loadInvertAim() });
  const detach = pipeline.attach(source);

  const watchdog = createMotionWatchdog(deps.onHealth, PHONE.motionWatchdogSec * 1000);
  const offFeed = source.onMotion(() => watchdog.feed());
  if (enable.motion.ok || sim) {
    source.start();
    watchdog.arm();
  } else {
    deps.onHealth('no-events');
  }

  let role = deps.role;
  let gunnerHasPowers = deps.gunnerHasPowers;
  let padsRoot = buildPadLayout(role, gunnerHasPowers);
  deps.mount.append(padsRoot);
  const onZone = (zone: string, down: boolean): void => {
    padsRoot.querySelector(`[data-zone="${zone}"]`)?.classList.toggle('held', down);
  };
  let pads = new Pads(padsRoot, onZone);
  let suspended = false;
  const makeSender = (): { stop(): void } =>
    startInputSender({
      role,
      pipeline,
      pads,
      send: deps.send,
      hz: tuning.sendHz,
      gunnerHasPowers,
      onCalibrate: deps.onCalibrate,
      suspended: () => suspended,
    });
  let sender = makeSender();
  const stopOrientation = watchOrientation((info) => deps.onOrientation(info.landscape));

  return {
    enable,
    pipeline,
    get pads() {
      return pads;
    },
    get padsRoot() {
      return padsRoot;
    },
    snapshot: () => pipeline.snapshot(),
    setRole(next: Role, nextGunnerHasPowers: boolean): void {
      if (next === role && nextGunnerHasPowers === gunnerHasPowers) return;
      role = next;
      gunnerHasPowers = nextGunnerHasPowers;
      sender.stop();
      pads.dispose();
      padsRoot.remove();
      padsRoot = buildPadLayout(role, gunnerHasPowers);
      deps.mount.append(padsRoot);
      pads = new Pads(padsRoot, onZone);
      sender = makeSender();
    },
    setSuspended(on: boolean): void {
      suspended = on;
    },
    restartSensors(): void {
      source.stop();
      pipeline.resetFilters();
      source.start();
      watchdog.arm();
    },
    dispose(): void {
      sender.stop();
      stopOrientation();
      offFeed();
      watchdog.dispose();
      detach();
      source.stop();
      pads.dispose();
      padsRoot.remove();
      wake.dispose();
    },
  };
}
