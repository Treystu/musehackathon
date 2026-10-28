// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ValidatedIntent } from '../../src/core/ai/provider';
import { IntentEditor } from '../../src/ui/ai/IntentEditor';

const base: ValidatedIntent = {
  mode: 'lookup',
  geographies: ['Hilo', 'Honolulu'],
  metricKeys: ['median_gross_rent'],
  filters: [],
  clarificationNeeded: false,
};

function StatefulEditor() {
  const [intent, setIntent] = useState<ValidatedIntent>(base);
  return <IntentEditor intent={intent} onChange={setIntent} />;
}

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

function statusText(): string | null {
  const el = container.querySelector('p[role="status"]');
  return el ? (el.textContent ?? '') : null;
}

describe('Error-clearing (successful chip removal clears error state)', () => {
  it('failed edit shows error, then successful chip removal clears it with no stale error', async () => {
    act(() => {
      root.render(<StatefulEditor />);
    });

    // Fail an edit: blank place add -> error appears.
    const placeForm = container.querySelector('#intent-place')?.closest('form');
    expect(placeForm).not.toBeNull();
    await act(async () => {
      placeForm!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(statusText()).toContain('Enter a place first.');

    // Successful chip removal -> error cleared, chip gone.
    const removeHilo = container.querySelector(
      'button[aria-label="Remove place Hilo"]',
    ) as HTMLButtonElement;
    expect(removeHilo).not.toBeNull();
    act(() => {
      removeHilo.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(statusText()).toBeNull();
    expect(
      container.querySelector('button[aria-label="Remove place Hilo"]'),
    ).toBeNull();
    expect(
      container.querySelector('button[aria-label="Remove place Honolulu"]'),
    ).not.toBeNull();
  });
});
