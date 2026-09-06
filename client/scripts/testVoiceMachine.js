// Node regression tests for the Advanced Voice interaction state machine.
// Run with: node scripts/testVoiceMachine.js
// Framework-free: imports only the DOM-free machine module.
/* global process:readonly */

import { VoiceInteractionMachine, VOICE_INTERACTION_STATES } from '../src/utils/voiceInteractionMachine.js';

let failures = 0;
const check = (label, fn) => {
  try {
    fn();
    console.log(`  PASS  ${label}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL  ${label}`);
    console.error(`        ${err.message}`);
  }
};
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg || 'assertion failed');
};
const eq = (a, b, msg) => {
  if (a !== b) throw new Error(`${msg || 'mismatch'} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
};

const makeHarness = () => {
  const calls = [];
  const machine = new VoiceInteractionMachine({
    log: () => {},
    actions: {
      startCapture: (turn) => calls.push(['startCapture', turn]),
      stopCapture: (reason) => calls.push(['stopCapture', reason]),
      interruptGeneration: () => calls.push(['interruptGeneration']),
    },
  });
  return { machine, calls };
};

console.log('VoiceInteractionMachine tests');
console.log('=============================');

console.log('\nSCENARIO A — full turn, mic off while speaking');
check('activate → listening, capture starts', () => {
  const { machine, calls } = makeHarness();
  const turn = machine.activate();
  eq(machine.state, 'listening');
  eq(machine.active, true);
  assert(calls.some(([c, t]) => c === 'startCapture' && t === turn), 'startCapture with turn');
});
check('utterance submit → processing, capture stopped, turn invalidated', () => {
  const { machine, calls } = makeHarness();
  const turn = machine.activate();
  assert(machine.onUtteranceSubmitted(turn) === true, 'submit accepted');
  eq(machine.state, 'processing');
  assert(calls.some(([c]) => c === 'stopCapture'), 'stopCapture called');
  assert(machine.isTurnValid(turn) === false, 'old turn invalid');
});
check('speech start → speaking, capture stopped', () => {
  const { machine, calls } = makeHarness();
  const turn = machine.activate();
  machine.onUtteranceSubmitted(turn);
  const stopsBefore = calls.filter(([c]) => c === 'stopCapture').length;
  assert(machine.onSpeechStarted() === true, 'speech start accepted');
  eq(machine.state, 'speaking');
  assert(calls.filter(([c]) => c === 'stopCapture').length > stopsBefore, 'capture stopped on speaking');
});
check('speech end → listening, capture restarts with new turn', () => {
  const { machine, calls } = makeHarness();
  machine.activate();
  machine.onUtteranceSubmitted(1);
  machine.onSpeechStarted();
  const startsBefore = calls.filter(([c]) => c === 'startCapture').length;
  assert(machine.onSpeechEnded() === true, 'speech end accepted');
  eq(machine.state, 'listening');
  const starts = calls.filter(([c]) => c === 'startCapture');
  assert(starts.length > startsBefore, 'capture restarted');
  eq(starts[starts.length - 1][1], machine.turn, 'restart uses current turn');
});
check('stale utterance submit after speaking is dropped', () => {
  const { machine } = makeHarness();
  const turn = machine.activate();
  machine.onUtteranceSubmitted(turn);
  machine.onSpeechStarted();
  assert(machine.onUtteranceSubmitted(turn) === false, 'stale submit rejected');
  eq(machine.state, 'speaking');
});

console.log('\nSCENARIO B — barge-in with one tap');
check('toggle while speaking interrupts and returns to listening (stays in mode)', () => {
  const { machine, calls } = makeHarness();
  machine.activate();
  machine.onUtteranceSubmitted(1);
  machine.onSpeechStarted();
  eq(machine.toggle(), 'barged-in');
  eq(machine.state, 'listening');
  eq(machine.active, true);
  assert(calls.some(([c]) => c === 'interruptGeneration'), 'generation interrupted');
  assert(calls.filter(([c]) => c === 'startCapture').length >= 2, 'capture restarted after barge-in');
});
check('toggle while listening exits voice mode entirely', () => {
  const { machine } = makeHarness();
  machine.activate();
  eq(machine.toggle(), 'deactivated');
  eq(machine.state, 'idle');
  eq(machine.active, false);
});
check('toggle while processing cancels generation and exits', () => {
  const { machine, calls } = makeHarness();
  machine.activate();
  machine.onUtteranceSubmitted(1);
  eq(machine.toggle(), 'cancelled');
  eq(machine.active, false);
  eq(machine.state, 'idle');
  assert(calls.some(([c]) => c === 'interruptGeneration'), 'generation interrupted');
});

console.log('\nSCENARIO C — repeated turns without button presses');
check('three full turns cycle cleanly', () => {
  const { machine } = makeHarness();
  let turn = machine.activate();
  for (let i = 0; i < 3; i += 1) {
    assert(machine.onUtteranceSubmitted(turn) === true, `turn ${i} submit`);
    assert(machine.onSpeechStarted() === true, `turn ${i} speech start`);
    assert(machine.onSpeechEnded() === true, `turn ${i} speech end`);
    eq(machine.state, 'listening');
    turn = machine.turn;
  }
  eq(machine.active, true);
});

console.log('\nSCENARIO D — rapid interruption, no stale state');
check('repeated speak → interrupt cycles stay consistent', () => {
  const { machine } = makeHarness();
  machine.activate();
  for (let i = 0; i < 4; i += 1) {
    const t = machine.turn;
    machine.onUtteranceSubmitted(t);
    machine.onSpeechStarted();
    assert(machine.bargeIn() === true, `barge ${i}`);
    eq(machine.state, 'listening');
    eq(machine.active, true);
  }
});
check('double barge-in is a safe no-op the second time', () => {
  const { machine, calls } = makeHarness();
  machine.activate();
  machine.onUtteranceSubmitted(1);
  machine.onSpeechStarted();
  assert(machine.bargeIn() === true, 'first barge-in');
  const interrupts = calls.filter(([c]) => c === 'interruptGeneration').length;
  assert(machine.bargeIn() === false, 'second barge-in rejected (not speaking)');
  eq(calls.filter(([c]) => c === 'interruptGeneration').length, interrupts, 'no duplicate interrupt');
});

console.log('\nStale-callback protection');
check('late speech-started after deactivation is ignored', () => {
  const { machine } = makeHarness();
  machine.activate();
  machine.deactivate('test');
  assert(machine.onSpeechStarted() === false, 'ignored when inactive');
  eq(machine.state, 'idle');
});
check('speech-ended with no speech does not restart capture', () => {
  const { machine, calls } = makeHarness();
  machine.activate();
  const starts = calls.filter(([c]) => c === 'startCapture').length;
  assert(machine.onSpeechEnded() === false, 'rejected while listening');
  eq(calls.filter(([c]) => c === 'startCapture').length, starts, 'no restart');
});
check('error state stops capture and blocks stale events', () => {
  const { machine, calls } = makeHarness();
  const turn = machine.activate();
  machine.onError('mic denied');
  eq(machine.state, 'error');
  assert(calls.some(([c]) => c === 'stopCapture'), 'capture stopped on error');
  assert(machine.onUtteranceSubmitted(turn) === false, 'stale submit dropped in error');
  assert(machine.onSpeechEnded() === false, 'speech end dropped in error');
});
check('toggle from error exits to idle', () => {
  const { machine } = makeHarness();
  machine.activate();
  machine.onError('mic denied');
  eq(machine.toggle(), 'deactivated');
  eq(machine.state, 'idle');
});

console.log('\nRestart listening (silent cycles)');
check('restartListening refreshes the turn and restarts capture', () => {
  const { machine, calls } = makeHarness();
  const turn = machine.activate();
  const startsBefore = calls.filter(([c]) => c === 'startCapture').length;
  assert(machine.restartListening('empty cycle') === true, 'restart accepted');
  eq(machine.state, 'listening');
  assert(machine.isTurnValid(turn) === false, 'old turn invalidated');
  const starts = calls.filter(([c]) => c === 'startCapture');
  assert(starts.length > startsBefore, 'capture restarted');
  eq(starts[starts.length - 1][1], machine.turn, 'restart uses new turn');
});
check('restartListening rejected outside listening', () => {
  const { machine } = makeHarness();
  assert(machine.restartListening('x') === false, 'rejected while idle');
  machine.activate();
  machine.onUtteranceSubmitted(1);
  assert(machine.restartListening('x') === false, 'rejected while processing');
});

console.log('\nInvariants');check('speaking always stops capture; listening always starts it', () => {
  const { machine, calls } = makeHarness();
  machine.activate();
  machine.onUtteranceSubmitted(1);
  const stops = () => calls.filter(([c]) => c === 'stopCapture').length;
  const starts = () => calls.filter(([c]) => c === 'startCapture').length;
  const s0 = stops();
  machine.onSpeechStarted();
  assert(stops() > s0, 'stopCapture on speaking');
  const r0 = starts();
  machine.onSpeechEnded();
  assert(starts() > r0, 'startCapture on listening');
});
check('every transition bumps the turn exactly once', () => {
  const { machine } = makeHarness();
  eq(machine.turn, 0);
  machine.activate(); eq(machine.turn, 1);
  machine.onUtteranceSubmitted(1); eq(machine.turn, 2);
  machine.onSpeechStarted(); eq(machine.turn, 3);
  machine.onSpeechEnded(); eq(machine.turn, 4);
});

console.log(`\n${failures === 0 ? 'All machine tests passed.' : `${failures} test(s) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);
