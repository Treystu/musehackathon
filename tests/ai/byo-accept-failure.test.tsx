// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMetaKey, setMetaKey } from '../../src/core/ai/meta-key';
import { createStubProvider, type IntentRequest } from '../../src/core/ai/provider';
import { AskPanel } from '../../src/ui/ai/AskPanel';

function creditsError() {
  return Object.assign(new Error('shared allowance used up'), {
    code: 'credits_exhausted',
  });
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  clearMetaKey();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  clearMetaKey();
});

function render(node: ReactNode) {
  act(() => root.render(node));
}

function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (!setter) throw new Error('input value setter unavailable');
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function submitForm(form: HTMLFormElement) {
  return act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}

/**
 * Item 4b pin: BYO-direct returns an unvalidatable intent → the
 * "cannot be run as asked" copy appears, no crash, no intent runs.
 */
describe('BYO accept-failure path', () => {
  it('BYO-direct invalid intent shows cannot-run copy, no crash, no intent runs', async () => {
    expect(setMetaKey('stub-personal-key-0123456789abcdef')).toBe(true);
    const sharedCalls: IntentRequest[] = [];
    const byoCalls: IntentRequest[] = [];
    const onExecute = vi.fn();
    const provider = createStubProvider({
      async intent(req) {
        sharedCalls.push(req);
        throw creditsError();
      },
    });
    const byoProvider = createStubProvider({
      async intent(req) {
        byoCalls.push(req);
        return {
          intent: {
            mode: 'lookup' as const,
            geographies: ['Hilo'],
            metricKeys: ['not_a_real_metric_xyz'],
            filters: [],
            clarificationNeeded: false,
          },
        };
      },
    });
    render(<AskPanel provider={provider} byoProvider={byoProvider} onExecute={onExecute} />);
    const input = container.querySelector('#ask-input') as HTMLInputElement;
    const form = container.querySelector('form') as HTMLFormElement;
    typeInto(input, 'rent in Hilo');
    await submitForm(form);

    expect(sharedCalls).toHaveLength(1);
    expect(byoCalls).toHaveLength(1);
    expect(container.textContent).toContain('cannot be run as asked');
    expect(container.textContent).not.toContain('Run this request');
    expect(onExecute).not.toHaveBeenCalled();
  });
});
