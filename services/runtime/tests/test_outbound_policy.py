from __future__ import annotations

from dataclasses import dataclass, replace
from types import SimpleNamespace
from typing import Any

from langchain_core.messages import HumanMessage, SystemMessage, ToolMessage

from local_host.agent.context_builder import RuntimeContext
from local_host.middleware.outbound_policy import OutboundPolicyMiddleware


@dataclass(frozen=True)
class _Request:
    messages: list[Any]
    system_message: SystemMessage
    runtime: Any

    def override(self, **changes: Any) -> _Request:
        return replace(self, **changes)


def _request(*, external: bool) -> _Request:
    context = RuntimeContext(
        outbound_is_external=external,
        outbound_pii_types=("email",),
        outbound_secrets=("secret-provider-key",),
    )
    return _Request(
        messages=[
            HumanMessage(content="email alice@example.com key secret-provider-key"),
            ToolMessage(
                content="owner alice@example.com key secret-provider-key",
                tool_call_id="call-1",
            ),
        ],
        system_message=SystemMessage(content="never print secret-provider-key"),
        runtime=SimpleNamespace(context=context),
    )


def test_external_policy_redacts_request_copy_without_mutating_graph_messages() -> None:
    request = _request(external=True)

    outbound = OutboundPolicyMiddleware._apply(request)

    assert "alice@example.com" not in str(outbound.messages[0].content)
    assert "[REDACTED_EMAIL]" in str(outbound.messages[0].content)
    assert "secret-provider-key" not in str(outbound.messages)
    assert "secret-provider-key" not in str(outbound.system_message.content)
    assert "alice@example.com" in str(request.messages[0].content)
    assert "secret-provider-key" in str(request.messages[0].content)


def test_local_provider_keeps_pii_but_still_filters_known_credentials() -> None:
    request = _request(external=False)

    outbound = OutboundPolicyMiddleware._apply(request)

    assert "alice@example.com" in str(outbound.messages[0].content)
    assert "secret-provider-key" not in str(outbound.messages[0].content)


def test_external_policy_also_redacts_runtime_task_copy_in_system_prompt() -> None:
    request = _request(external=True)
    request = replace(
        request,
        system_message=SystemMessage(content="<task>email alice@example.com</task>"),
    )

    outbound = OutboundPolicyMiddleware._apply(request)

    assert "alice@example.com" not in str(outbound.system_message.content)
    assert "[REDACTED_EMAIL]" in str(outbound.system_message.content)


def test_short_known_credential_is_not_skipped() -> None:
    request = _request(external=False)
    request.runtime.context.outbound_secrets = ("k",)
    request = replace(request, messages=[HumanMessage(content="token=k")])

    outbound = OutboundPolicyMiddleware._apply(request)

    assert outbound.messages[0].content == "to[REDACTED_CREDENTIAL]en=[REDACTED_CREDENTIAL]"
