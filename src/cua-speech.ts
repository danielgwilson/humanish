/** Speech recognized from the participant desktop's actual speaker sink. */
export interface HeardSpeech {
  id: string;
  source: "speaker_audio";
  text: string;
  durationMs: number;
}

export const CUA_SPEECH_LIMITS = Object.freeze({ characters: 400, bytes: 1600, utterances: 4, durationMs: 120_000 });

