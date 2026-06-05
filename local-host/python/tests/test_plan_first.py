"""Tests for PlanFirstMiddleware — Plan & Execute mode."""

from __future__ import annotations

from langchain_core.messages import HumanMessage

from local_host.middleware.plan_first import (
    AUTO_COMPLEX_CHARS,
    PLAN_FIRST_SYSTEM_PROMPT,
    PlanFirstMiddleware,
    _looks_complex,
)

# --- mode parsing ---


def test_mode_off_by_default(monkeypatch) -> None:
    monkeypatch.delenv("SHEJANE_PLAN_FIRST", raising=False)
    mw = PlanFirstMiddleware()
    assert mw.mode == "off"


def test_mode_always_synonyms(monkeypatch) -> None:
    for val in ("1", "true", "yes", "on", "always", "ALWAYS"):
        monkeypatch.setenv("SHEJANE_PLAN_FIRST", val)
        mw = PlanFirstMiddleware()
        assert mw.mode == "always", f"value {val!r} should map to always"


def test_mode_auto(monkeypatch) -> None:
    monkeypatch.setenv("SHEJANE_PLAN_FIRST", "auto")
    mw = PlanFirstMiddleware()
    assert mw.mode == "auto"


def test_mode_explicit_constructor_overrides_env(monkeypatch) -> None:
    monkeypatch.setenv("SHEJANE_PLAN_FIRST", "off")
    mw = PlanFirstMiddleware(mode="always")
    assert mw.mode == "always"


# --- _looks_complex heuristic ---


def test_looks_complex_long_message() -> None:
    long_text = "a" * (AUTO_COMPLEX_CHARS + 1)
    assert _looks_complex([HumanMessage(content=long_text)]) is True


def test_looks_complex_short_message_with_hint() -> None:
    assert _looks_complex([HumanMessage(content="please research X")]) is True


def test_looks_complex_short_simple_message() -> None:
    assert _looks_complex([HumanMessage(content="what time is it?")]) is False


def test_looks_complex_no_user_message() -> None:
    assert _looks_complex([]) is False


# --- before_agent behavior ---


def test_off_mode_does_not_inject() -> None:
    mw = PlanFirstMiddleware(mode="off")
    state = {"messages": [HumanMessage(content="research market trends in Q4 2026")]}
    assert mw.before_agent(state, runtime=None) is None


def test_always_mode_prepends_plan_first_system_message() -> None:
    mw = PlanFirstMiddleware(mode="always")
    state = {"messages": [HumanMessage(content="hi")]}
    result = mw.before_agent(state, runtime=None)
    assert result is not None
    first = result["messages"][0]
    assert getattr(first, "type", None) == "system"
    assert "write_todos" in first.content
    # Original message preserved after
    assert result["messages"][1].content == "hi"


def test_auto_mode_skips_trivial_task() -> None:
    mw = PlanFirstMiddleware(mode="auto")
    state = {"messages": [HumanMessage(content="what time is it?")]}
    assert mw.before_agent(state, runtime=None) is None


def test_auto_mode_triggers_on_complex_task() -> None:
    mw = PlanFirstMiddleware(mode="auto")
    state = {
        "messages": [HumanMessage(content="please research the latest LangGraph release notes")]
    }
    result = mw.before_agent(state, runtime=None)
    assert result is not None
    assert getattr(result["messages"][0], "type", None) == "system"


def test_injection_content_matches_protocol_template() -> None:
    """Guard against accidental rewording — the prompt content is the
    contract with the LLM."""
    mw = PlanFirstMiddleware(mode="always")
    result = mw.before_agent({"messages": [HumanMessage(content="x")]}, runtime=None)
    assert result["messages"][0].content == PLAN_FIRST_SYSTEM_PROMPT
