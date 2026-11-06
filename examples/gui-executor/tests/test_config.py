import pytest

from adc_gui_executor.ark import ArkClient


def test_environment_config_does_not_read_another_application(monkeypatch):
    monkeypatch.setenv("ARK_API_KEY", "fixture")
    monkeypatch.setenv("ARK_ENDPOINT", "https://example.invalid/v1/chat/completions")
    client = ArkClient()
    assert client.endpoint == "https://example.invalid/v1/chat/completions"


def test_missing_config_is_a_clear_local_error(monkeypatch):
    monkeypatch.delenv("ARK_API_KEY", raising=False)
    monkeypatch.delenv("ARK_ENDPOINT", raising=False)
    with pytest.raises(ValueError, match="ark_api_key_required"):
        ArkClient()


@pytest.mark.parametrize("endpoint", [
    "http://example.invalid", "https://user:secret@example.invalid",
    "https://example.invalid?token=fixture", "https://example.invalid#fragment",
])
def test_endpoint_error_never_contains_configuration(monkeypatch, endpoint):
    monkeypatch.setenv("ARK_API_KEY", "fixture")
    monkeypatch.setenv("ARK_ENDPOINT", endpoint)
    with pytest.raises(ValueError) as raised:
        ArkClient()
    assert str(raised.value) == "ark_endpoint_invalid"
