// Holdout helpers moved to @agentic-marketing/artifacts so campaigns measure with the same
// assignment and statistics. Re-exported here because journeys.holdoutResult and its tests use
// them from this package.
export {
  type ArmCounts,
  type ArmResult,
  analyseHoldout,
  armFor,
  assignHoldout,
  type HoldoutAnalysis,
  type HoldoutArm,
  type HoldoutAssignment,
  type HoldoutConfig,
  type HoldoutScope,
  type HoldoutVerdict,
  holdoutBucket,
  holdoutDetail,
  holdoutHashVersion,
  holdoutParticipantId,
  newcombeDifference,
  wilsonInterval,
  Z_95,
} from '@agentic-marketing/artifacts';
