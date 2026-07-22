import { describe, it, expect } from 'vitest';
import { createJmlStateMachine, isActiveLike, isJmlKind, JML_TRANSITIONS } from './jml.js';

const jml = createJmlStateMachine();

describe('JML lifecycle state machine', () => {
  it('permits sensible direct transitions', () => {
    expect(jml.canTransition('active', 'on_leave')).toBe(true);
    expect(jml.canTransition('active', 'terminated')).toBe(true);
    expect(jml.canTransition('on_leave', 'active')).toBe(true);
    expect(jml.canTransition('terminated', 'onboarding')).toBe(true); // rehire path
    expect(jml.canTransition('active', 'active')).toBe(true); // self-transition
  });

  it('forbids nonsensical transitions', () => {
    expect(jml.canTransition('terminated', 'on_leave')).toBe(false);
    expect(jml.canTransition('disabled', 'on_leave')).toBe(false);
  });

  it('gates JML kinds by the current status', () => {
    expect(jml.isEligible('leaver.termination', 'active')).toBe(true);
    expect(jml.isEligible('leaver.termination', 'terminated')).toBe(false);
    expect(jml.isEligible('rehire', 'terminated')).toBe(true);
    expect(jml.isEligible('rehire', 'active')).toBe(false);
    expect(jml.isEligible('leaver.loa', 'active')).toBe(true);
  });

  it('plans a leaver to terminated and a leave of absence to on_leave', () => {
    expect(jml.plan('leaver.termination', 'active')).toEqual({ allowed: true, to: 'terminated' });
    expect(jml.plan('leaver.loa', 'active')).toEqual({ allowed: true, to: 'on_leave' });
  });

  it('plans movers as status-neutral', () => {
    const plan = jml.plan('mover.transfer', 'active');
    expect(plan.allowed).toBe(true);
    expect(plan.to).toBeNull();
  });

  it('refuses a plan that is not applicable and explains why', () => {
    const plan = jml.plan('rehire', 'active');
    expect(plan.allowed).toBe(false);
    expect(plan.to).toBeNull();
    expect(typeof plan.reason).toBe('string');
  });

  it('classifies active-like statuses', () => {
    expect(isActiveLike('active')).toBe(true);
    expect(isActiveLike('onboarding')).toBe(true);
    expect(isActiveLike('on_leave')).toBe(true);
    expect(isActiveLike('terminated')).toBe(false);
    expect(isActiveLike('disabled')).toBe(false);
  });

  it('recognizes JML kinds and rejects non-JML kinds', () => {
    expect(isJmlKind('joiner.hire')).toBe(true);
    expect(isJmlKind('leaver.termination')).toBe(true);
    expect(isJmlKind('login.success')).toBe(false);
    expect(isJmlKind('payment.sepa')).toBe(false);
  });

  it('has a transition table covering every status', () => {
    const statuses = Object.keys(JML_TRANSITIONS);
    expect(statuses).toContain('active');
    expect(statuses).toContain('terminated');
    // terminated is a near-terminal sink escaped only by rehire targets.
    expect(JML_TRANSITIONS.terminated).toEqual(['onboarding', 'active']);
  });
});
