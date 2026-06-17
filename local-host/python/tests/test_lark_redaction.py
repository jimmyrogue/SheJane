from __future__ import annotations

from local_host.lark.redact import redact_lark_text


def test_redacts_common_pii_and_lark_identifiers() -> None:
    result = redact_lark_text(
        "请联系 me@example.com 或 +86 138 0013 8000，"
        "链接 https://example.com/a?token=abc，服务器 10.0.0.5，"
        "群 oc_abcdef1234567890，用户 ou_abcdef1234567890。"
    )

    assert "me@example.com" not in result.text
    assert "138 0013 8000" not in result.text
    assert "https://example.com" not in result.text
    assert "10.0.0.5" not in result.text
    assert "oc_abcdef1234567890" not in result.text
    assert "ou_abcdef1234567890" not in result.text
    assert "[email]" in result.text
    assert "[phone]" in result.text
    assert "[url]" in result.text
    assert "[ip]" in result.text
    assert result.counts["lark_id"] == 2


def test_redacts_token_like_values_and_secret_assignments() -> None:
    result = redact_lark_text(
        "password = hunter2, api_key: sk_live_abcdefghijklmnopqrstuvwxyz, "
        "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9abcdef, order 12345678901234567890"
    )

    assert "hunter2" not in result.text
    assert "sk_live_abcdefghijklmnopqrstuvwxyz" not in result.text
    assert "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9abcdef" not in result.text
    assert "12345678901234567890" not in result.text
    assert "[secret]" in result.text
    assert "[token]" in result.text
    assert "[long_number]" in result.text
