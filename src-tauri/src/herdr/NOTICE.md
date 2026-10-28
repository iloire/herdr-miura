# Herdr attribution

`wire.rs` and `endpoint.rs` in this directory are copied from Herdr,
<https://github.com/herdrdev/herdr>, licensed under the Apache License 2.0. The
license is reproduced in `LICENSE-APACHE` beside this file. Herdr ships no
NOTICE file of its own.

Source: Herdr 0.9.5, commit
[`2ecf19a`](https://github.com/herdrdev/herdr/commit/2ecf19a), from
`src/protocol/wire.rs` and `src/protocol/endpoint.rs`, plus `WindowsKeyRecord`
from `src/input/model.rs`, `AgentStatus` from `src/api/schema/common.rs`, and
`ToastHerdrPosition` from `src/config/model.rs`.

Changes: kept only the declarations the endpoint protocol carries, with their
serde helpers and `CellData`'s `Clone`; removed the `bincode::Decode` derives,
Herdr's conversions to its terminal and input types, the server-side builders,
and the optional surface encodings. Field and variant order is unchanged: it is
the bincode contract with the daemon.

Everything else here (`client.rs`, `session.rs`, `surface.rs`, `codec.rs`,
`socket.rs`) is this project's own code. `socket.rs` follows the socket path
rules of Herdr's `src/server/socket_paths.rs`, `src/session.rs`, and
`src/config/io.rs`.

When the daemon's protocol changes, copy the changed declarations from the
matching Herdr release, update the source line above, and run the live test
(`HERDR_TEST_CLIENT_SOCKET=... cargo test live_daemon -- --ignored`) against
a daemon of that version.
