# Acceptance criteria

The build is considered functionally ready when all of the following are true:

1. Settings validate and persist the destination, port, base coordinates, device count and connection ramp.
2. Generated IMEIs are unique, 15 digits and increment from `358988888800001` without gaps.
3. At least 25% of the requested devices are classified as moving.
4. Every device uses an independent persistent TCP socket.
5. A device sends GT06 login before heartbeat or location and becomes Online only after a valid login acknowledgement.
6. Moving positions maintain continuity and use elapsed time, speed and heading consistently.
7. Parked positions remain fixed with speed zero.
8. Moving and parked location schedules are 10 seconds and 5 minutes respectively.
9. Split, combined and malformed server frames cannot corrupt the receive parser.
10. Failed connections reconnect with bounded exponential backoff and jitter.
11. Stopping closes sockets, scheduler timers and the worker without leaving transmission running.
12. UI logs are bounded and disk logs rotate.
13. CSV and JSON IMEI exports match the configured device population.
14. Protocol unit tests and a real local TCP integration test pass.

