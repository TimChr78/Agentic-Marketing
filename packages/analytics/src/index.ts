export * from './campaign';
export * from './campaignSummary';
export * from './compile';
export * from './query';
export * from './registry';
export * from './reports';

import { analyticsCampaignSummary } from './campaignSummary';
import { analyticsMetricsList, analyticsQuery } from './query';
import { analyticsReports } from './reports';

/** Everything the server registers: the generic query, the catalogue, and the named reports. */
export const analyticsCommands = [analyticsQuery, analyticsMetricsList, analyticsCampaignSummary, ...analyticsReports] as const;
