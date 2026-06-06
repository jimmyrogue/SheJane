"""Advanced agent-settings per-run overrides (the client's "Advanced" panel).

`runs._apply_advanced_overrides` folds knobs from the per-run `settings` dict
onto a copy of the base daemon Settings WITHOUT re-validating (model_copy), so
these tests pin the coercion + allow-list behavior that keeps bad client input
from reaching the run loop.
"""

from __future__ import annotations

from local_host.config import Settings
from local_host.runs import _apply_advanced_overrides


def _base() -> Settings:
    # Pin the fields under test to known values so assertions don't depend on
    # the developer's .env / shell environment.
    return Settings(
        SHEJANE_LOCAL_INPUT_GUARD="observe",
        SHEJANE_PLAN_FIRST="off",
        SHEJANE_LOCAL_CRITIC="",
    )


def test_empty_overrides_returns_base_unchanged() -> None:
    base = _base()
    # No knobs sent ⇒ the exact same object (no needless copy) ⇒ legacy
    # callers behave identically.
    assert _apply_advanced_overrides(base, {}) is base


def test_all_knobs_applied_with_coercion() -> None:
    base = _base()
    eff = _apply_advanced_overrides(
        base,
        {
            "max_model_calls": "50",  # string → int
            "max_tool_retries": 4,
            "tool_selector_max": "8",
            "subagents": False,  # real bool
            "reflect": "on",  # truthy string
            "browser_headless": "off",  # falsey string
            "tool_critic": "Block",  # case-insensitive → normalized
            "input_guard": "block",
            "plan_first": "auto",
            "pii_redact": "email,credit_card",
        },
    )
    assert eff.max_model_calls == 50 and isinstance(eff.max_model_calls, int)
    assert eff.max_tool_retries == 4
    assert eff.tool_selector_max_tools == 8
    assert eff.enable_subagents is False
    assert eff.enable_critic_reflection is True
    assert eff.browser_headless is False
    assert eff.tool_critic_mode == "block"
    assert eff.input_guard_mode == "block"
    assert eff.plan_first_mode == "auto"
    assert eff.pii_redact_types == "email,credit_card"
    # Copy semantics: the base instance is never mutated.
    assert base.max_model_calls == 20
    assert base.enable_subagents is True


def test_invalid_values_are_ignored() -> None:
    base = _base()
    eff = _apply_advanced_overrides(
        base,
        {
            "max_model_calls": "not-a-number",  # unparseable → ignored
            "tool_critic": "explode",  # off allow-list → ignored
            "plan_first": "sometimes",  # off allow-list → ignored
            "unknown_knob": "whatever",  # unknown key → ignored
        },
    )
    assert eff.max_model_calls == base.max_model_calls
    assert eff.tool_critic_mode == base.tool_critic_mode
    assert eff.plan_first_mode == base.plan_first_mode


def test_partial_override_leaves_others_at_base() -> None:
    base = _base()
    eff = _apply_advanced_overrides(base, {"plan_first": "always"})
    assert eff.plan_first_mode == "always"
    # Everything the client didn't send stays at the base value.
    assert eff.input_guard_mode == base.input_guard_mode
    assert eff.enable_subagents == base.enable_subagents
    assert eff.max_model_calls == base.max_model_calls
