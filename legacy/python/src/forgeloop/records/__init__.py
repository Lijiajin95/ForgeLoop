"""本地记录层：SQLite 权威业务记录。

在既有检查点读取之上，公开人工续跑决定与检查点可信判定入口，供上层 fail-closed
地决定「能否续跑」以及记录并回查人工决定。具体规则见
:mod:`forgeloop.records.checkpoints`。
"""

from forgeloop.records.checkpoints import (
    INTERRUPTED,
    MAX_DECIDED_BY_LENGTH,
    CheckpointHealth,
    CheckpointInspection,
    CheckpointState,
    RetryAuthorization,
    RetryCheck,
    RetryDecision,
    authorize_retry,
    clear_halted_reason,
    inspect_checkpoint,
    latest_retry_decision,
    read_authorized_checkpoint,
    retry_decisions,
    validate_retry,
)

__all__ = [
    "INTERRUPTED",
    "MAX_DECIDED_BY_LENGTH",
    "CheckpointHealth",
    "CheckpointInspection",
    "CheckpointState",
    "RetryAuthorization",
    "RetryCheck",
    "RetryDecision",
    "authorize_retry",
    "clear_halted_reason",
    "inspect_checkpoint",
    "latest_retry_decision",
    "read_authorized_checkpoint",
    "retry_decisions",
    "validate_retry",
]
