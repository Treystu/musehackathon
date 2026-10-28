// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStubProvider, type ValidatedIntent } from '../../src/core/ai/provider';
import { AskPanel } from '../../src/ui/ai/AskPanel';

const runnable: ValidatedIntent = {
  mode: 'lookup',
  geographies: ['Hilo'],
  metricKeys: ['median_gross_rent'],
  filters: [],
  clarificationNeeded: false,
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function findRun(): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find(
    (b) => b.textContent === 'Run this request',
  ) as HTMLButtonElement | undefined;
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

describe('Run-noop (no enabled Run with no handler)', () => {
  it('no onExecute -> Run renders disabled, not clickable', async () => {
    const provider = createStubProvider({
      async intent() {
        return { intent: runnable };
      },
    });
    act(() => {
      root.render(<AskPanel provider={provider} />);
    });
    typeInto(container.querySelector('#ask-input') as HTMLInputElement, 'rent in Hilo');
    await submitForm(container.querySelector('form') as HTMLFormElement);

    const run = findRun();
    expect(run).toBeDefined();
    expect(run?.disabled).toBe(true);
    expect(container.querySelector('button:not([disabled])')?.textContent).not.toBe(
      'Run this request',
    );
  });

  it('with onExecute -> Run present, enabled, and clickable', async () => {
    const onExecute = vi.fn();
    const provider = createStubProvider({
      async intent() {
        return { intent: runnable };
      },
    });
    act(() => {
      root.render(<AskPanel provider={provider} onExecute={onExecute} />);
    });
    typeInto(container.querySelector('#ask-input') as HTMLInputElement, 'rent in Hilo');
    await submitForm(container.querySelector('form') as HTMLFormElement);

    const run = findRun();
    expect(run).toBeDefined();
    expect(run?.disabled).toBe(false);
    act(() => {
      run?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onExecute).toHaveBeenCalledTimes(1);
    expect(onExecute).toHaveBeenCalledWith(runnable);
  });
});
