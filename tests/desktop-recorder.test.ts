import { describe, expect, it } from "vitest";
import { buildDesktopRecorderCommand } from "../src/desktop-recorder.js";

describe("desktop recorder command", () => {
  it("builds one fixed full-desktop H.264/AAC recipe with explicit capture points", () => {
    const command = buildDesktopRecorderCommand({ display: ":0", width: 960, height: 720, outputPath: "/home/humanish/desktop.mp4",
      audioSources: ["microphone-input", "speaker-output"] });
    expect(command.binary).toBe("/usr/bin/ffmpeg");
    expect(command.args).toEqual([
      "-nostdin", "-v", "error", "-y", "-f", "x11grab", "-framerate", "15", "-video_size", "960x720", "-i", ":0",
      "-thread_queue_size", "512", "-f", "pulse", "-i", "humanish_mic.monitor",
      "-thread_queue_size", "512", "-f", "pulse", "-i", "humanish_speaker.monitor",
      "-filter_complex", "[1:a][2:a]amix=inputs=2:normalize=0[a]", "-map", "0:v", "-map", "[a]",
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28", "-pix_fmt", "yuv420p", "-c:a", "aac",
      "-movflags", "+faststart", "/home/humanish/desktop.mp4"
    ]);
  });

  it("builds video-only output and rejects ambiguous paths or duplicate sources", () => {
    expect(buildDesktopRecorderCommand({ display: ":0", width: 960, height: 720, outputPath: "/tmp/desktop.mp4" }).args).not.toContain("pulse");
    expect(() => buildDesktopRecorderCommand({ display: ":0", width: 960, height: 720, outputPath: "/tmp/../desktop.mp4" })).toThrow();
    expect(() => buildDesktopRecorderCommand({ display: ":0", width: 960, height: 720, outputPath: "/tmp/desktop.mp4",
      audioSources: ["speaker-output", "speaker-output"] })).toThrow();
  });
});
