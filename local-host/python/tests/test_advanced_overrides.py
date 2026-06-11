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
            "max_history_turns": "12",
            "max_model_retries": "1",
            "max_tool_retries": 4,
            "research_search_limit": "6",
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
    assert eff.max_history_turns == 12
    assert eff.max_model_retries == 1
    assert eff.max_tool_retries == 4
    assert eff.research_search_limit == 6
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


def test_verification_repair_max_env_is_clamped() -> None:
    assert Settings(SHEJANE_LOCAL_VERIFY_REPAIR_MAX="").verification_repair_max == 1
    assert Settings(SHEJANE_LOCAL_VERIFY_REPAIR_MAX=0).verification_repair_max == 0
    assert Settings(SHEJANE_LOCAL_VERIFY_REPAIR_MAX=9).verification_repair_max == 3


def test_max_history_turns_is_clamped() -> None:
    assert Settings(max_history_turns="").max_history_turns == 40
    assert Settings(max_history_turns=0).max_history_turns == 1
    assert Settings(max_history_turns=999).max_history_turns == 200
    base = _base()
    assert _apply_advanced_overrides(base, {"max_history_turns": -5}).max_history_turns == 1
    assert _apply_advanced_overrides(base, {"max_history_turns": 999}).max_history_turns == 200


def test_run_budget_integer_knobs_are_clamped() -> None:
    assert Settings(max_model_calls=0).max_model_calls == 1
    assert Settings(max_model_calls=999).max_model_calls == 100
    assert Settings(max_model_retries=-1).max_model_retries == 0
    assert Settings(max_model_retries=99).max_model_retries == 5
    assert Settings(max_tool_retries=-1).max_tool_retries == 0
    assert Settings(max_tool_retries=99).max_tool_retries == 5
    assert Settings(research_search_limit=0).research_search_limit == 1
    assert Settings(research_search_limit=99).research_search_limit == 20
    assert Settings(tool_selector_max_tools=-1).tool_selector_max_tools == 0
    assert Settings(tool_selector_max_tools=99).tool_selector_max_tools == 50

    base = _base()
    eff = _apply_advanced_overrides(
        base,
        {
            "max_model_calls": -5,
            "max_model_retries": -1,
            "max_tool_retries": 999,
            "research_search_limit": 0,
            "tool_selector_max": 999,
        },
    )
    assert eff.max_model_calls == 1
    assert eff.max_model_retries == 0
    assert eff.max_tool_retries == 5
    assert eff.research_search_limit == 1
    assert eff.tool_selector_max_tools == 50


def test_partial_override_leaves_others_at_base() -> None:
    base = _base()
    eff = _apply_advanced_overrides(base, {"plan_first": "always"})
    assert eff.plan_first_mode == "always"
    # Everything the client didn't send stays at the base value.
    assert eff.input_guard_mode == base.input_guard_mode
    assert eff.enable_subagents == base.enable_subagents
    assert eff.max_model_calls == base.max_model_calls


def test_input_guard_override_may_strengthen_but_not_weaken() -> None:
    # Security-posture floor: a per-run client override can RAISE the guard
    # but never lower a machine/env baseline. Strength: off < observe < block.
    strong = Settings(SHEJANE_LOCAL_INPUT_GUARD="block")
    # Client tries to downgrade block → observe: ignored, stays block.
    assert _apply_advanced_overrides(strong, {"input_guard": "observe"}).input_guard_mode == "block"
    # Client tries to downgrade block → off: ignored (off not even allowed).
    assert _apply_advanced_overrides(strong, {"input_guard": "off"}).input_guard_mode == "block"

    weak = Settings(SHEJANE_LOCAL_INPUT_GUARD="observe")
    # Client strengthens observe → block: applied.
    assert _apply_advanced_overrides(weak, {"input_guard": "block"}).input_guard_mode == "block"
    # Same level is a no-op (and never copies needlessly).
    assert _apply_advanced_overrides(weak, {"input_guard": "observe"}) is weak


def test_pii_redaction_override_can_only_add_types() -> None:
    # Security-posture floor: a per-run override unions onto the baseline; it
    # can ADD entity types but never drop one (clearing must not re-expose PII).
    base = Settings(SHEJANE_LOCAL_PII_REDACT="email,credit_card")
    # Clearing is refused — baseline types survive.
    assert (
        _apply_advanced_overrides(base, {"pii_redact": ""}).pii_redact_types == "email,credit_card"
    )
    # A subset is refused — still the full baseline.
    assert (
        _apply_advanced_overrides(base, {"pii_redact": "email"}).pii_redact_types
        == "email,credit_card"
    )
    # Adding a new type unions it on (baseline order preserved).
    assert (
        _apply_advanced_overrides(base, {"pii_redact": "ip"}).pii_redact_types
        == "email,credit_card,ip"
    )
    # From an empty baseline the client may freely set types.
    empty = Settings(SHEJANE_LOCAL_PII_REDACT="")
    assert _apply_advanced_overrides(empty, {"pii_redact": "email"}).pii_redact_types == "email"
