from typing import Annotated, Literal

import numpy as np
from pydantic import BaseModel, ConfigDict, Field, model_validator


MAZES = {
    "switchback": ("Switchback", [
        "S..#....#", "##.#.##.#", "...#....#", ".#...##.#", ".###....#",
        ".....##.#", "#.##....#", "#....#..G",
    ]),
    "crossroads": ("Crossroads", [
        "S.......#", ".#.###..#", "...#....#", "##...##.#", "...#.....",
        ".#.#.###.", "...#.....", "###.....G",
    ]),
    "courtyard": ("Courtyard", [
        "S........", ".#######.", ".........", ".#.....#.", ".#.....#.",
        ".#######.", ".........", "........G",
    ]),
}
DIRECTIONS = ((-1, 0), (0, 1), (1, 0), (0, -1))
ACTION_NAMES = ("Up", "Right", "Down", "Left")
HISTORY_LIMIT = 80
Number = Annotated[float, Field(allow_inf_nan=False)]
State = tuple[Annotated[int, Field(ge=0, le=7)], Annotated[int, Field(ge=0, le=8)]]
Values = tuple[Number, Number, Number, Number]


class Model(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Configuration(Model):
    maze: Literal["switchback", "crossroads", "courtyard"] = "switchback"
    episodes: int = Field(default=120, ge=1, le=2000)
    max_steps: int = Field(default=120, ge=10, le=500)
    alpha: float = Field(default=0.25, gt=0, le=1)
    gamma: float = Field(default=0.95, ge=0, le=1)
    epsilon: float = Field(default=1.0, ge=0, le=1)
    epsilon_min: float = Field(default=0.05, ge=0, le=1)
    epsilon_decay: float = Field(default=0.96, gt=0, le=1)
    seed: int = Field(default=42, ge=0, le=2**32 - 1)

    @model_validator(mode="after")
    def check_epsilon(self):
        if self.epsilon_min > self.epsilon:
            raise ValueError("Minimum exploration must be at most initial exploration")
        return self


class Episode(Model):
    episode: int = Field(ge=1, le=2000)
    steps: int = Field(ge=1, le=500)
    reward: Number
    success: bool


class Transition(Model):
    state: State
    action: Literal[0, 1, 2, 3]
    reward: Number
    next_state: State
    q_before: Number
    td_target: Number
    td_error: Number
    q_after: Number
    episode: int = Field(ge=1, le=2000)
    step: int = Field(ge=1, le=500)
    terminal: bool
    explored: bool
    epsilon: float = Field(ge=0, le=1)


class RandomState(Model):
    # Decimal strings avoid rounding 128-bit NumPy integers in browser JSON.
    state: str = Field(pattern=r"^[0-9]{1,39}$")
    inc: str = Field(pattern=r"^[0-9]{1,39}$")
    has_uint32: Literal[0, 1]
    uinteger: int = Field(ge=0, le=2**32 - 1)

    @model_validator(mode="after")
    def check_pcg64(self):
        if max(int(self.state), int(self.inc)) >= 2**128 or int(self.inc) % 2 != 1:
            raise ValueError("Invalid PCG64 state")
        return self


class Snapshot(Model):
    version: Literal[1] = 1
    config: Configuration
    q: list[Values] = Field(min_length=72, max_length=72)
    completed: int = Field(ge=0, le=2000)
    wins: int = Field(ge=0, le=2000)
    total_steps: int = Field(ge=0, le=1_000_000)
    episode_steps: int = Field(ge=0, le=500)
    episode_reward: Number
    epsilon: float = Field(ge=0, le=1)
    state: State
    trail: list[State] = Field(min_length=1, max_length=501)
    history: list[Episode] = Field(max_length=HISTORY_LIMIT)
    last: Transition | None = None
    rng: RandomState

    @model_validator(mode="after")
    def check_progress(self):
        if not self.wins <= self.completed <= self.config.episodes:
            raise ValueError("Invalid episode progress")
        if self.episode_steps >= self.config.max_steps or self.total_steps < self.episode_steps + self.completed:
            raise ValueError("Invalid step progress")
        if self.completed == self.config.episodes and self.episode_steps:
            raise ValueError("A completed run cannot have an active episode")
        if not self.config.epsilon_min <= self.epsilon <= self.config.epsilon:
            raise ValueError("Invalid exploration rate")
        rows = MAZES[self.config.maze][1]
        if self.state != self.trail[-1] or any(rows[r][c] == "#" for r, c in self.trail):
            raise ValueError("Invalid maze position")
        if len(self.history) != min(self.completed, HISTORY_LIMIT) or any(
            episode.episode != index
            for index, episode in enumerate(self.history, self.completed - len(self.history) + 1)
        ):
            raise ValueError("Invalid episode history")
        if (self.last is None) != (self.total_steps == 0) or any(abs(value) > 10_000 for row in self.q for value in row):
            raise ValueError("Invalid Q-learning state")
        return self


class Trainer:
    def __init__(self, config: Configuration, snapshot: Snapshot | None = None):
        self.config = config
        self.rows = MAZES[config.maze][1]
        self.goal = next((r, row.index("G")) for r, row in enumerate(self.rows) if "G" in row)
        self.start = next((r, row.index("S")) for r, row in enumerate(self.rows) if "S" in row)
        self.rng = np.random.Generator(np.random.PCG64(config.seed))
        if snapshot is None:
            self.q = np.zeros((72, 4))
            self.state = self.start
            self.trail = [self.start]
            self.completed = self.wins = self.total_steps = self.episode_steps = 0
            self.episode_reward = 0.0
            self.epsilon = config.epsilon
            self.history: list[Episode] = []
            self.last: Transition | None = None
            return
        self.q = np.array(snapshot.q)
        self.state = snapshot.state
        self.trail = list(snapshot.trail)
        self.completed = snapshot.completed
        self.wins = snapshot.wins
        self.total_steps = snapshot.total_steps
        self.episode_steps = snapshot.episode_steps
        self.episode_reward = snapshot.episode_reward
        self.epsilon = snapshot.epsilon
        self.history = list(snapshot.history)
        self.last = snapshot.last
        self.rng.bit_generator.state = {
            "bit_generator": "PCG64",
            "state": {"state": int(snapshot.rng.state), "inc": int(snapshot.rng.inc)},
            "has_uint32": snapshot.rng.has_uint32,
            "uinteger": snapshot.rng.uinteger,
        }

    @property
    def done(self) -> bool:
        return self.completed == self.config.episodes

    def values(self, state: State):
        row, column = state
        return self.q[row * len(self.rows[0]) + column]

    def step(self) -> Transition:
        if self.done:
            raise ValueError("Experiment is complete")
        if self.episode_steps == 0:
            self.state = self.start
            self.trail = [self.start]

        state = self.state
        values = self.values(state)
        explored = bool(self.rng.random() < self.epsilon)
        choices = np.arange(4) if explored else np.flatnonzero(values == values.max())
        action = int(self.rng.choice(choices))
        dy, dx = DIRECTIONS[action]
        row, column = state[0] + dy, state[1] + dx
        blocked = not (0 <= row < len(self.rows) and 0 <= column < len(self.rows[0])) or self.rows[row][column] == "#"
        next_state = state if blocked else (row, column)
        success = next_state == self.goal
        self.episode_steps += 1
        self.total_steps += 1
        terminal = success or self.episode_steps >= self.config.max_steps
        reward = 1.0 if success else -0.12 if blocked else -0.03

        q_before = float(values[action])
        target = reward if terminal else reward + self.config.gamma * float(self.values(next_state).max())
        error = target - q_before
        q_after = q_before + self.config.alpha * error
        values[action] = q_after

        self.state = next_state
        self.trail.append(next_state)
        self.episode_reward += reward
        self.last = Transition(
            state=state, action=action, reward=reward, next_state=next_state,
            q_before=q_before, td_target=target, td_error=error, q_after=q_after,
            episode=self.completed + 1, step=self.episode_steps, explored=explored,
            terminal=terminal, epsilon=self.epsilon,
        )
        if terminal:
            self.completed += 1
            self.wins += int(success)
            self.history = [*self.history[-(HISTORY_LIMIT - 1):], Episode(
                episode=self.completed, steps=self.episode_steps, reward=self.episode_reward, success=success,
            )]
            self.epsilon = max(self.config.epsilon_min, self.epsilon * self.config.epsilon_decay)
            self.episode_steps = 0
            self.episode_reward = 0.0
        return self.last

    def snapshot(self) -> Snapshot:
        rng = self.rng.bit_generator.state
        return Snapshot(
            config=self.config, q=self.q.tolist(), completed=self.completed, wins=self.wins,
            total_steps=self.total_steps, episode_steps=self.episode_steps, episode_reward=self.episode_reward,
            epsilon=self.epsilon, state=self.state, trail=self.trail, history=self.history, last=self.last,
            rng=RandomState(
                state=str(rng["state"]["state"]), inc=str(rng["state"]["inc"]),
                has_uint32=rng["has_uint32"], uinteger=rng["uinteger"],
            ),
        )

    def advance(self, count: int) -> list[Transition]:
        events = []
        for _ in range(count):
            if self.done:
                break
            event = self.step()
            events.append(event)
            if event.terminal:
                break
        return events
