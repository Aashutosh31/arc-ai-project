// server/lib/WorkspaceLogger.js
// Structured logging for workspace runtime observability

class WorkspaceLogger {
  constructor(name = 'Workspace') {
    this.name = name;
  }

  // Workspace lifecycle events
  workspaceResolved(userId, workspaceId, vectorNamespace) {
    console.info(`[${this.name}:RESOLVED] userId=${userId} workspaceId=${workspaceId} namespace=${vectorNamespace}`);
  }

  workspaceSwitched(userId, oldWorkspaceId, newWorkspaceId) {
    console.info(`[${this.name}:SWITCHED] userId=${userId} from=${oldWorkspaceId} to=${newWorkspaceId}`);
  }

  workspaceDefaultCreated(userId, workspaceId, namespace) {
    console.info(`[${this.name}:DEFAULT_CREATED] userId=${userId} workspaceId=${workspaceId} namespace=${namespace}`);
  }

  // Retrieval events
  retrievalExecuted(userId, workspaceId, source, resultCount) {
    console.info(`[${this.name}:RETRIEVAL] userId=${userId} workspace=${workspaceId} source=${source} results=${resultCount}`);
  }

  semanticSearchExecuted(userId, workspaceId, namespace, query, resultCount) {
    console.info(`[${this.name}:SEMANTIC_SEARCH] userId=${userId} workspace=${workspaceId} namespace=${namespace} query=${query ? query.slice(0, 50) : 'N/A'} results=${resultCount}`);
  }

  // Execution events
  executionCreated(userId, executionId, workspaceId, title) {
    console.info(`[${this.name}:EXECUTION_CREATED] userId=${userId} executionId=${executionId} workspace=${workspaceId} title=${title}`);
  }

  executionStarted(userId, executionId, workspaceId, stepCount) {
    console.info(`[${this.name}:EXECUTION_STARTED] userId=${userId} executionId=${executionId} workspace=${workspaceId} steps=${stepCount}`);
  }

  executionStepCompleted(userId, executionId, workspaceId, stepIndex, tool, status) {
    console.info(`[${this.name}:STEP_COMPLETED] userId=${userId} executionId=${executionId} workspace=${workspaceId} step=${stepIndex} tool=${tool} status=${status}`);
  }

  executionCompleted(userId, executionId, workspaceId, finalStatus) {
    console.info(`[${this.name}:EXECUTION_COMPLETED] userId=${userId} executionId=${executionId} workspace=${workspaceId} status=${finalStatus}`);
  }

  // Recovery events
  recoveryAttempted(userId, executionId, workspaceId, tool, strategy) {
    console.info(`[${this.name}:RECOVERY_ATTEMPT] userId=${userId} executionId=${executionId} workspace=${workspaceId} tool=${tool} strategy=${strategy}`);
  }

  recoverySucceeded(userId, executionId, workspaceId, tool, strategy) {
    console.info(`[${this.name}:RECOVERY_SUCCESS] userId=${userId} executionId=${executionId} workspace=${workspaceId} tool=${tool} strategy=${strategy}`);
  }

  // Vector namespace events
  vectorNamespaceUsed(userId, workspaceId, namespace, operation) {
    console.info(`[${this.name}:VECTOR_NAMESPACE] userId=${userId} workspace=${workspaceId} namespace=${namespace} operation=${operation}`);
  }

  // Isolation events
  isolationViolationAttempted(userId, attemptedWorkspaceId, requestedWorkspaceId, resource) {
    console.warn(`[${this.name}:ISOLATION_VIOLATION] userId=${userId} attempted=${attemptedWorkspaceId} requested=${requestedWorkspaceId} resource=${resource}`);
  }

  // Provider continuity events
  providerContinuityMaintained(userId, workspaceId, provider, toolCount) {
    console.info(`[${this.name}:PROVIDER_CONTINUITY] userId=${userId} workspace=${workspaceId} provider=${provider} toolCalls=${toolCount}`);
  }

  // Error events
  workspaceError(context, error) {
    console.error(`[${this.name}:ERROR] context=${context} error=${error?.message || error}`);
  }
}

module.exports = WorkspaceLogger;
