import { describe, expect, it } from "vitest";
import {
  buildDesktopRecorderCommand,
  buildDesktopRecorderProbeCommand,
  buildDesktopRecorderPulseSetupCommands,
  parseDesktopRecorderDuration,
} from "../../src/evidence/desktop-recorder.js";
import { DESKTOP_RECORDING_MAX_BYTES } from "../../src/evidence/desktop-recording-types.js";

describe("desktop recorder command", () => {
  it("builds one fixed full-desktop H.264/AAC recipe with explicit capture points", () => {
    const command = buildDesktopRecorderCommand(
      {
        display: ":0",
        width: 960,
        height: 720,
        outputPath: "/tmp/desktop.mp4",
        audioSources: ["microphone-input", "speaker-output"],
      },
      1_790_457_914_571,
    );
    expect(command.binary).toBe("/usr/bin/ffmpeg");
    expect(command.args).toEqual([
      "-nostdin",
      "-v",
      "error",
      "-y",
      "-copyts",
      "-vsync",
      "vfr",
      "-thread_queue_size",
      "32",
      "-probesize",
      "32",
      "-analyzeduration",
      "0",
      "-f",
      "x11grab",
      "-framerate",
      "15",
      "-video_size",
      "960x720",
      "-i",
      ":0",
      "-thread_queue_size",
      "512",
      "-probesize",
      "32",
      "-analyzeduration",
      "0",
      "-fflags",
      "nobuffer",
      "-f",
      "pulse",
      "-sample_rate",
      "48000",
      "-channels",
      "2",
      "-i",
      "humanish_recording.monitor",
      "-map",
      "0:v",
      "-map",
      "1:a",
      "-vf",
      "pad=ceil(iw/2)*2:ceil(ih/2)*2",
      "-c:v",
      "libx264",
      "-enc_time_base:v",
      "1:1000000",
      "-preset",
      "ultrafast",
      "-crf",
      "28",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-fs",
      String(DESKTOP_RECORDING_MAX_BYTES - 1024 * 1024),
      "-movflags",
      "+faststart",
      "-output_ts_offset",
      "-1790457914.571",
      "/tmp/desktop.mp4",
    ]);
    expect(buildDesktopRecorderPulseSetupCommands().map((command) => command.args)).toEqual([
      [
        "load-module",
        "module-null-sink",
        "sink_name=humanish_recording",
        "sink_properties=device.description=HumanishRecordingMix",
        "norewinds=true",
      ],
      ["set-sink-volume", "humanish_recording", "0.5"],
      [
        "load-module",
        "module-loopback",
        "source=humanish_mic.monitor",
        "sink=humanish_recording",
        "latency_msec=20",
      ],
      [
        "load-module",
        "module-loopback",
        "source=humanish_speaker.monitor",
        "sink=humanish_recording",
        "latency_msec=20",
      ],
    ]);
  });

  it("builds video-only output and rejects ambiguous paths or duplicate sources", () => {
    expect(
      buildDesktopRecorderCommand(
        { display: ":0", width: 960, height: 720, outputPath: "/tmp/desktop.mp4" },
        1,
      ).args,
    ).not.toContain("pulse");
    expect(() =>
      buildDesktopRecorderCommand(
        { display: ":0", width: 960, height: 720, outputPath: "/tmp/../desktop.mp4" },
        1,
      ),
    ).toThrow();
    expect(() =>
      buildDesktopRecorderCommand(
        {
          display: ":0",
          width: 960,
          height: 720,
          outputPath: "/tmp/desktop.mp4",
          audioSources: ["speaker-output", "speaker-output"],
        },
        1,
      ),
    ).toThrow();
  });

  it("builds a bounded duration probe and parses its result", () => {
    expect(buildDesktopRecorderProbeCommand("/tmp/desktop.mp4")).toEqual({
      binary: "/usr/bin/ffprobe",
      args: [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        "/tmp/desktop.mp4",
      ],
    });
    expect(parseDesktopRecorderDuration("25.042000\n")).toBe(25_042);
    expect(() => parseDesktopRecorderDuration("N/A\n")).toThrow();
  });
});
