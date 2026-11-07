import type { Model } from 'survey-core';

declare global {
  const Survey: typeof import('survey-core');
  const SurveyUI: typeof import('survey-js-ui');
  const tus: typeof import('tus-js-client');
  var SurveyKeyboard: {
    attach(
      container: HTMLElement,
      getSurvey: () => Model | undefined,
      isBusy?: () => boolean,
    ): void;
  };
  var ProductMediaUploader: typeof MediaUploader;

  type SurveyModel = Model;
  type SurveySchema = Record<string, unknown>;
  interface LoginChallenge {
    challengeId: string;
    resendAt: string;
    message: string;
  }
  interface RegistrationChallenge {
    challengeId: string;
    contacts: {
      channel: 'email' | 'phone';
      destination: string;
      resendAt: string;
      verified: boolean;
      delivery: string;
    }[];
  }
  interface CartItem {
    productId: string;
    name: string;
    quantity: number;
    available: boolean;
    unitPrice: number | null;
    lineTotal: number | null;
    thumbnail?: string | null;
  }
  interface CartView {
    items: CartItem[];
    itemCount: number;
    total: number;
    unavailableCount: number;
    maxQuantity: number;
  }
  interface MediaConfig {
    endpoint: string;
    accept: string;
    maxFiles: number;
    maxVideos: number;
    imageBytes: number;
    videoBytes: number;
    productBytes: number;
    maxDuration: number;
    ticketsPerHour?: number;
    lifetime?: number;
  }
  interface SavedMedia {
    id: string;
    name: string;
    kind: 'image' | 'video';
    size: number;
    url: string;
    poster?: string | null;
  }
  interface MediaStatus {
    status: string;
    url: string;
    poster?: string | null;
    attached?: boolean;
    error?: string;
  }
}

export {};
