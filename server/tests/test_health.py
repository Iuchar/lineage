from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health_answers() -> None:
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_unknown_api_address_is_404_not_interface() -> None:
    assert client.get("/api/nothing-here").status_code == 404


def test_missing_file_is_404_not_interface() -> None:
    assert client.get("/favicon.ico").status_code == 404


def test_interface_answers_head() -> None:
    assert client.head("/").status_code in (200, 503)
