use super::*;

#[test]
fn a_quiet_link_is_pinged_once_then_fails_unanswered() {
    let start = Instant::now();
    let mut health = Health::new(start);
    assert_eq!(health.tick(start + QUIET / 2), Ok(false));
    assert_eq!(health.tick(start + QUIET), Ok(true));
    assert_eq!(health.tick(start + QUIET + Duration::from_secs(1)), Ok(false), "one ping at a time");
    assert_eq!(health.tick(start + QUIET + PING_TIMEOUT), Err(Timeout));
}

#[test]
fn anything_received_answers_the_ping() {
    let start = Instant::now();
    let mut health = Health::new(start);
    assert_eq!(health.tick(start + QUIET), Ok(true));
    let answered = start + QUIET + Duration::from_secs(1);
    health.received(answered);
    assert_eq!(health.tick(answered + QUIET / 2), Ok(false));
    assert_eq!(health.tick(answered + QUIET), Ok(true), "and the next quiet spell pings again");
}

#[test]
fn a_probe_pings_now_and_fails_sooner() {
    let start = Instant::now();
    let mut health = Health::new(start);
    health.probe(start);
    assert_eq!(health.tick(start), Ok(true));
    assert_eq!(health.tick(start + PROBE_TIMEOUT), Err(Timeout));
}

#[test]
fn a_probe_shortens_a_ping_already_out() {
    let start = Instant::now();
    let mut health = Health::new(start);
    assert_eq!(health.tick(start + QUIET), Ok(true));
    health.probe(start + QUIET);
    assert_eq!(health.tick(start + QUIET + PROBE_TIMEOUT), Err(Timeout));
}
