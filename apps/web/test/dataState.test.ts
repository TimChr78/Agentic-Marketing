import { describe, expect, it } from 'vitest';
import { chartStateOf, DATA_STATE, dataState, dataStateCopy, kpiStateOf } from '../src/lib/dataState';

describe('metric data states (#437)', () => {
  it('reports no data for a zero or missing sample, never healthy', () => {
    expect(dataState({ value: 0, sampleSize: 0, minSample: 100 })).toBe('no-data');
    expect(dataState({ value: null, sampleSize: 1200, minSample: 100 })).toBe('no-data');
    expect(dataState({ value: 0.01, sampleSize: undefined, minSample: 100 })).toBe('no-data');
  });

  it('reports below evaluation volume before any healthy or warning state', () => {
    expect(dataState({ value: 0.02, sampleSize: 38, minSample: 100 })).toBe('below-volume');
    expect(dataState({ value: 0.02, sampleSize: 38, minSample: 100, warning: true })).toBe('below-volume');
  });

  it('is healthy only with a real sample at or above the threshold', () => {
    expect(dataState({ value: 0.04, sampleSize: 1200, minSample: 100 })).toBe('healthy');
    expect(dataState({ value: 0, sampleSize: 1200, minSample: 100 })).toBe('healthy');
  });

  it('uses the source’s own warning flag, not a guessed threshold', () => {
    expect(dataState({ value: 0.04, sampleSize: 1200, minSample: 100, warning: true })).toBe('warning');
  });

  it('lets pause and suppression win over volume', () => {
    expect(dataState({ value: 0.04, sampleSize: 1200, minSample: 100, paused: true })).toBe('paused');
    expect(dataState({ value: 4, sampleSize: 1200, minSample: 100, suppressed: true })).toBe('suppressed');
    expect(dataState({ value: 0, sampleSize: 0, minSample: 100, suppressed: true })).toBe('suppressed');
  });

  it('has plain labels and tones for every state', () => {
    expect(DATA_STATE['no-data']).toEqual({ label: 'No data in this period', tone: 'neutral' });
    expect(DATA_STATE['below-volume']).toEqual({ label: 'Below evaluation volume', tone: 'neutral' });
    expect(DATA_STATE.healthy).toEqual({ label: 'Healthy', tone: 'good' });
    expect(DATA_STATE.warning).toEqual({ label: 'Warning', tone: 'warn' });
    expect(DATA_STATE.paused).toEqual({ label: 'Paused', tone: 'neutral' });
    expect(DATA_STATE.suppressed).toEqual({ label: 'Suppressed', tone: 'neutral' });
  });

  it('copies the sample size and threshold into the explanation', () => {
    expect(dataStateCopy('below-volume', { sampleSize: 38, minSample: 100 })).toBe('Below evaluation volume · 38 / 100 required');
    expect(dataStateCopy('healthy', { sampleSize: 1200, minSample: 100 })).toBe('Evaluated on 1,200 · threshold 100.');
    expect(dataStateCopy('no-data', { noData: 'No sends in the last 7 days.' })).toBe('No sends in the last 7 days.');
    expect(dataStateCopy('suppressed')).toBe('Suppressed · fewer than 5 people');
  });

  it('maps to the chart and KPI tile states without turning absent data into a value', () => {
    expect(kpiStateOf('healthy')).toBe('populated');
    expect(kpiStateOf('warning')).toBe('populated');
    expect(kpiStateOf('paused')).toBe('populated');
    expect(kpiStateOf('no-data')).toBe('no-data');
    expect(kpiStateOf('below-volume')).toBe('below-volume');
    expect(kpiStateOf('suppressed')).toBe('suppressed');
    expect(chartStateOf('no-data')).toBe('no-data');
    expect(chartStateOf('below-volume')).toBe('below-volume');
    expect(chartStateOf('suppressed')).toBe('suppressed');
    expect(chartStateOf('warning')).toBe('populated');
  });
});
