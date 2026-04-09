declare module "nodejs-whisper" {
  type WhisperOptions = {
    outputInCsv?: boolean;
    outputInJson?: boolean;
    outputInJsonFull?: boolean;
    outputInLrc?: boolean;
    outputInSrt?: boolean;
    outputInText?: boolean;
    outputInVtt?: boolean;
    outputInWords?: boolean;
    translateToEnglish?: boolean;
    wordTimestamps?: boolean;
    timestamps_length?: number;
    splitOnWord?: boolean;
  };

  type NodeWhisperConfig = {
    modelName?: string;
    autoDownloadModelName?: string;
    removeWavFileAfterTranscription?: boolean;
    withCuda?: boolean;
    logger?: Console;
    whisperOptions?: WhisperOptions;
  };

  export function nodewhisper(
    audioPath: string,
    config?: NodeWhisperConfig,
  ): Promise<string>;
}

