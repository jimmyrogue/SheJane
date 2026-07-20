"""Provider-bound outbound data policy.

Unlike state-mutating PII middleware, this middleware edits only the request
copy sent to the bound model. LangGraph checkpoints retain the user's original
content. Known credentials are always removed; optional legacy PII rules apply
only when the selected provider is external.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from functools import lru_cache
from typing import Any

from langchain.agents.middleware import AgentMiddleware
from langchain.agents.middleware.pii import RedactionRule, apply_strategy
from langchain_core.messages import BaseMessage, HumanMessage, SystemMessage, ToolMessage

_VALID_PII_TYPES = {"email", "credit_card", "ip", "mac_address", "url"}


def sanitize_outbound_text(
    text: str,
    *,
    secrets: tuple[str, ...] = (),
    pii_types: tuple[str, ...] = (),
    external: bool,
) -> str:
    return _sanitize_text(
        text,
        secrets=secrets,
        rules=_resolved_rules(pii_types) if external else (),
    )


class OutboundPolicyMiddleware(AgentMiddleware):
    """Apply runtime-bound data rules to a model request copy."""

    @staticmethod
    def _apply(request: Any) -> Any:
        context = getattr(getattr(request, "runtime", None), "context", None)
        if context is None:
            return request
        secrets = tuple(
            value
            for value in (getattr(context, "outbound_secrets", ()) or ())
            if isinstance(value, str) and bool(value)
        )
        external = bool(getattr(context, "outbound_is_external", False))
        pii_types = tuple(getattr(context, "outbound_pii_types", ()) or ()) if external else ()
        rules = _resolved_rules(pii_types)
        if not secrets and not rules:
            return request

        messages = [
            _sanitize_message(
                message,
                secrets=secrets,
                rules=rules if isinstance(message, (HumanMessage, ToolMessage)) else (),
            )
            for message in request.messages
        ]
        system_message = request.system_message
        if isinstance(system_message, SystemMessage):
            system_message = _sanitize_message(system_message, secrets=secrets, rules=rules)
        return request.override(messages=messages, system_message=system_message)

    def wrap_model_call(self, request: Any, handler: Callable[[Any], Any]) -> Any:
        return handler(self._apply(request))

    async def awrap_model_call(
        self,
        request: Any,
        handler: Callable[[Any], Awaitable[Any]],
    ) -> Any:
        return await handler(self._apply(request))


@lru_cache(maxsize=16)
def _resolved_rules(pii_types: tuple[str, ...]) -> tuple[Any, ...]:
    rules: list[Any] = []
    for pii_type in pii_types:
        normalized = str(pii_type).strip().lower()
        if normalized not in _VALID_PII_TYPES:
            continue
        rules.append(RedactionRule(pii_type=normalized, strategy="redact").resolve())
    return tuple(rules)


def _sanitize_message(
    message: BaseMessage,
    *,
    secrets: tuple[str, ...],
    rules: tuple[Any, ...],
) -> BaseMessage:
    content = message.content
    if isinstance(content, str):
        sanitized = _sanitize_text(content, secrets=secrets, rules=rules)
    elif isinstance(content, list):
        sanitized = []
        for item in content:
            if isinstance(item, str):
                sanitized.append(_sanitize_text(item, secrets=secrets, rules=rules))
            elif isinstance(item, dict) and isinstance(item.get("text"), str):
                sanitized.append(
                    {
                        **item,
                        "text": _sanitize_text(item["text"], secrets=secrets, rules=rules),
                    }
                )
            else:
                sanitized.append(item)
    else:
        return message
    return message if sanitized == content else message.model_copy(update={"content": sanitized})


def _sanitize_text(text: str, *, secrets: tuple[str, ...], rules: tuple[Any, ...]) -> str:
    sanitized = text
    for secret in secrets:
        sanitized = sanitized.replace(secret, "[REDACTED_CREDENTIAL]")
    for rule in rules:
        matches = rule.detector(sanitized)
        if matches:
            sanitized = apply_strategy(sanitized, matches, rule.strategy)
    return sanitized
