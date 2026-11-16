from collections import deque

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app import app
from lab import DIRECTIONS, MAZES, Configuration, Snapshot, Trainer


def greedy_config(**fields):
    return Configuration(epsilon=0, epsilon_min=0, **fields)


def test_q_learning_updates_the_selected_action_with_the_td_target():
    trainer = Trainer(greedy_config(alpha=0.25, gamma=0.9))
    trainer.values((0, 0))[1] = 0.2
    trainer.values((0, 1))[1] = 0.5
    event = trainer.step()
    assert (event.state, event.action, event.next_state) == ((0, 0), 1, (0, 1))
    assert event.reward == -0.03
    assert event.q_before == 0.2
    assert event.td_target == pytest.approx(0.42)
    assert event.td_error == pytest.approx(0.22)
    assert event.q_after == pytest.approx(0.255)
    assert trainer.values((0, 0))[1] == event.q_after


def test_wall_collision_and_terminal_update_do_not_advance_into_a_wall():
    trainer = Trainer(greedy_config(maze="courtyard", max_steps=10, episodes=1))
    trainer.values(trainer.start)[0] = 1.0
    event = trainer.step()
    assert event.state == event.next_state == trainer.start
    assert event.reward == -0.12
    trainer.state = (7, 7)
    trainer.values((7, 7))[1] = 0.4
    trainer.values(trainer.goal)[1] = 9
    event = trainer.step()
    assert event.terminal and event.next_state == trainer.goal
    assert event.td_target == 1.0
    assert trainer.done and trainer.wins == 1
    assert trainer.advance(8) == []


@pytest.mark.parametrize("maze", MAZES)
def test_maze_goal_is_reachable_and_agent_learns(maze):
    trainer = Trainer(Configuration(maze=maze, episodes=180))
    frontier = deque([trainer.start])
    seen = {trainer.start}
    while frontier:
        row, column = frontier.popleft()
        for dy, dx in DIRECTIONS:
            r, c = row + dy, column + dx
            if 0 <= r < 8 and 0 <= c < 9 and trainer.rows[r][c] != "#" and (r, c) not in seen:
                seen.add((r, c))
                frontier.append((r, c))
    assert trainer.goal in seen

    while not trainer.done:
        trainer.advance(8)
    assert sum(episode.success for episode in trainer.history[-20:]) >= 18
    assert trainer.epsilon == trainer.config.epsilon_min


def test_json_snapshot_preserves_rng_values_and_future_episode_metrics():
    config = Configuration(max_steps=20, episodes=100)
    original = Trainer(config)
    for _ in range(13):
        original.advance(7)
    serialized = original.snapshot().model_dump_json()
    snapshot = Snapshot.model_validate_json(serialized)
    resumed = Trainer(snapshot.config, snapshot)
    assert resumed.snapshot() == original.snapshot()
    for _ in range(100):
        assert original.advance(8) == resumed.advance(8)
    assert resumed.snapshot() == original.snapshot()


def test_websocket_pause_then_reconnect_matches_http_replay():
    config = Configuration().model_dump(mode="json")
    with TestClient(app) as client:
        assert client.get("/api/health").json() == {"status": "ok", "protocol": 1}
        assert len(client.get("/api/experiments").json()) == 3
        with client.websocket_connect("/api/ws") as wire:
            wire.send_json({"type": "open", "config": config})
            snapshot = wire.receive_json()["snapshot"]
            assert snapshot["total_steps"] == 0
            wire.send_json({"type": "advance", "count": 1})
            first = wire.receive_json()
            assert first["snapshot"]["total_steps"] == 1
            assert len(first["events"]) == 1

        expected = client.post("/api/training/step", json={"snapshot": first["snapshot"], "count": 8})
        assert expected.status_code == 200
        with client.websocket_connect("/api/ws") as wire:
            wire.send_json({"type": "open", "config": config, "snapshot": first["snapshot"]})
            assert wire.receive_json()["snapshot"] == first["snapshot"]
            wire.send_json({"type": "advance", "count": 8})
            assert wire.receive_json() == expected.json()
            wire.send_json({"type": "advance", "count": 9})
            assert wire.receive_json()["type"] == "error"
            with pytest.raises(WebSocketDisconnect) as closed:
                wire.receive_json()
            assert closed.value.code == 1008


def test_connection_lease_ends_cleanly_and_keeps_checkpoint_restorable(monkeypatch):
    monkeypatch.setenv("MAZE_WS_LEASE_SECONDS", "1")
    config = Configuration().model_dump(mode="json")
    with TestClient(app) as client:
        with client.websocket_connect("/api/ws") as wire:
            wire.send_json({"type": "open", "config": config})
            wire.receive_json()
            wire.send_json({"type": "advance", "count": 3})
            checkpoint = wire.receive_json()["snapshot"]
            with pytest.raises(WebSocketDisconnect) as closed:
                wire.receive_json()
            assert closed.value.code == 1012
        with client.websocket_connect("/api/ws") as wire:
            wire.send_json({"type": "open", "config": config, "snapshot": checkpoint})
            assert wire.receive_json()["snapshot"] == checkpoint
