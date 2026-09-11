# Stream.io — Product Concepts & Add-ons Explainer

Mental models for the three Stream products and all video add-ons. Written during the Apr 2026 pricing research sprint to clarify the pricing unit differences (participant-minutes vs call-minutes) and what each product actually does.

---

## The Three Products

### Video Calls

Real-time, bidirectional communication between participants. Everyone can see and hear everyone else simultaneously. Priced on **participant-minutes** — every person in the call consumes minutes.

Typical use cases: 1:1 consultations, group classes, team meetings.

The calculator reflects this: 4 participants × 60 min × 500 sessions = 120,000 participant-minutes, because all 4 people are "consuming" video simultaneously.

### Live Streaming

One-to-many, unidirectional broadcast. One host (or a small panel) streams to a large audience who are passive viewers. Think YouTube Live or Twitch. The host publishes one stream; viewers receive it — but viewers don't publish back.

This is why it scales to thousands of viewers cheaply: Stream only encodes the stream once, then distributes it. Priced the same way (participant-minutes) but the economics are different because only the broadcaster's stream is encoded at high quality, not every viewer's camera.

### Activity Feeds

Completely different product — not video at all. Think Twitter/Instagram-style social feeds: follow graphs, timelines, notification feeds, "X liked your post" events. It's a database-backed pub/sub system for social interactions. Billed as flat monthly plan tiers (Start/Elevate) with an included API call quota — not per-minute like Video.

Use cases: "show me all posts from people I follow", "send a notification when someone comments." Familiarise could use it for a discovery feed of consultants, but doesn't currently.

---

## Add-ons Explained

### HLS Live Streaming ($0.96/1K participant-minutes)

HLS = HTTP Live Streaming. Converts a WebRTC video call into a standard HLS stream that can be embedded in a webpage or played by any video player — no WebRTC browser support needed.

Use case: running a live webinar inside Stream's video call, but also broadcasting it to a public webpage where anonymous viewers watch via a standard `<video>` player. The add-on handles the transcoding from WebRTC → HLS segments.

> Confirmed at $0.96/1K PM via live calculator — distinct from the $0.30 Audio Only base rate shown in the static pricing text.

Only available in **Live Streaming mode** (the HLS button is disabled in Video Calls mode in the calculator).

### Noise Cancellation ($0.30/1K participant-minutes)

AI-powered background noise suppression applied in real-time to audio streams. Filters out keyboard typing, traffic, HVAC noise, barking dogs, etc. Runs as a processing layer on Stream's edge infrastructure before audio reaches other participants.

Priced per participant-minute because it's processing every participant's audio stream continuously. For a 1:1 60-minute consultation, both participants' audio is being processed = 120 participant-minutes of noise cancellation.

### Transcriptions / Closed Captions ($8.00/1K call-minutes)

Real-time speech-to-text that generates live captions during a call. Priced per **call-minute** (not participant-minute) because the audio is transcribed once per call — it doesn't matter if there are 2 or 200 people on the call, you're transcribing one audio stream.

Use cases: accessibility compliance, live subtitles, post-call searchable transcripts. At $8/1K call-minutes, a 60-minute consultation costs $0.48 in transcription.

### RTMP In ($15.00/1K call-minutes)

Lets an external source inject a video stream into a Stream call using the RTMP protocol. RTMP (Real-Time Messaging Protocol) is the standard used by OBS, Streamlabs, broadcast cameras, and encoders.

Use case: a consultant using professional studio equipment (an ATEM mixer, a broadcast camera) and wants to push that high-quality feed into the Stream call rather than using a browser webcam. The "In" means the stream flows into Stream's infrastructure from outside.

Priced per call-minute (once per call, regardless of participant count) because real-time transcoding at the edge is expensive.

### RTMP Out ($15.00/1K call-minutes)

The reverse — takes a Stream call and pushes it out to an external RTMP destination like YouTube Live, Twitch, Facebook Live, or a CDN.

Use case: simultaneously broadcast a webinar to the Stream platform and YouTube Live. One call, two destinations. Also priced per call-minute since you're outputting one composed stream.

---

## Quick Mental Model

| Product        | Direction             | Priced on              | Familiarise use          |
| -------------- | --------------------- | ---------------------- | ------------------------ |
| Video Calls    | Many ↔ Many           | Participant-minutes     | Consultations, Classes   |
| Live Streaming | One → Many            | Participant-minutes     | Large webinars           |
| Activity Feeds | Database events       | API calls + activities  | Not yet used             |
| HLS add-on     | WebRTC → web embed    | Participant-minutes     | Public webinar embeds    |
| Noise Cancel   | Per-stream processing | Participant-minutes     | All calls                |
| Transcriptions | Once per call         | Call-minutes            | Accessibility            |
| RTMP In        | External → Stream     | Call-minutes            | Pro AV equipment         |
| RTMP Out       | Stream → External     | Call-minutes            | YouTube/Twitch simulcast |

**Key pricing unit distinction:**
- **Participant-minutes** = scales with audience size (more viewers = more cost)
- **Call-minutes** = fixed per session regardless of how many people are on it

---

## Related Documents

- [`00-pricing-overview.md`](./00-pricing-overview.md) — Stream pricing quick reference and cost cliff
- [`14-pricing-and-cost-model.md`](./14-pricing-and-cost-model.md) — Full rate tables and permutation matrices
- [`15-enterprise-and-maker-account.md`](./15-enterprise-and-maker-account.md) — Enterprise tiers, Maker account, AI Moderation
