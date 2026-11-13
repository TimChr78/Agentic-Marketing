import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api, errText } from '../../../app/api';
import type { ConsentRecord, PersonEvent, PersonMessage, PersonProfile } from './model';

// The person detail's exact reads (#510): profiles.get once, then the canonical id for one page of
// events, one page of messages and the unpaged consent ledger. Each source keeps its own cursor so
// one lane never advances another, and a failed lane leaves the successful ones on screen.

type PersonState = {
  data: PersonProfile | undefined;
  error: string | null;
  notFound: boolean;
  loading: boolean;
};

export function usePerson(profileId: string, enabled: boolean) {
  const [state, setState] = useState<PersonState>({ data: undefined, error: null, notFound: false, loading: enabled });
  const seq = useRef(0);

  const load = useCallback(async () => {
    if (!enabled) return;
    const n = ++seq.current;
    // A refresh clears the old profile so no previous value can be read as current.
    setState({ data: undefined, error: null, notFound: false, loading: true });
    try {
      const data = await api.call('profiles.get', { profileId });
      if (n !== seq.current) return;
      setState({ data, error: null, notFound: false, loading: false });
    } catch (e) {
      if (n !== seq.current) return;
      const notFound = e instanceof ApiError && (e.code === 'not_found' || e.status === 404);
      setState({ data: undefined, error: errText(e), notFound, loading: false });
    }
  }, [enabled, profileId]);

  // A new id, and an explicit reload, start from a clean profile with no previous values.
  useEffect(() => {
    seq.current += 1;
    if (!enabled) {
      setState({ data: undefined, error: null, notFound: false, loading: false });
      return;
    }
    setState({ data: undefined, error: null, notFound: false, loading: true });
    void load();
  }, [enabled, load]);

  return {
    ...state,
    loading: state.loading && state.data === undefined,
    reload: load,
  };
}

type TimelineState = {
  events: PersonEvent[];
  eventsCursor: { timestamp: string; eventId: string; name: string; anonymousId: string } | null;
  eventsError: string | null;
  eventsMoreError: string | null;
  messages: PersonMessage[];
  messagesCursor: string | null;
  messagesError: string | null;
  messagesMoreError: string | null;
  consent: ConsentRecord[];
  consentError: string | null;
  loading: boolean;
  loadingMoreEvents: boolean;
  loadingMoreMessages: boolean;
};

const emptyTimeline = (loading = false): TimelineState => ({
  events: [],
  eventsCursor: null,
  eventsError: null,
  eventsMoreError: null,
  messages: [],
  messagesCursor: null,
  messagesError: null,
  messagesMoreError: null,
  consent: [],
  consentError: null,
  loading,
  loadingMoreEvents: false,
  loadingMoreMessages: false,
});

export type ProfileTimelineState = ReturnType<typeof useProfileTimeline>;

export function useProfileTimeline(profileId: string | undefined, enabled: boolean) {
  const [state, setState] = useState<TimelineState>(() => emptyTimeline(enabled));
  const generation = useRef(0);

  const loadBase = useCallback(async () => {
    const gen = ++generation.current;
    if (!enabled || !profileId) {
      setState(emptyTimeline(false));
      return;
    }
    // A refresh drops the previous values rather than presenting them as current.
    setState(emptyTimeline(true));
    const [events, messages, consent] = await Promise.allSettled([
      api.call('profiles.events', { profileId, limit: 100 }),
      api.call('messages.list', { profileId, limit: 50 }),
      api.call('consent.history', { profileId }),
    ]);
    if (gen !== generation.current) return;
    setState({
      events: events.status === 'fulfilled' ? events.value.events : [],
      eventsCursor: events.status === 'fulfilled' ? events.value.nextCursor : null,
      eventsError: events.status === 'rejected' ? errText(events.reason) : null,
      eventsMoreError: null,
      messages: messages.status === 'fulfilled' ? messages.value.messages : [],
      messagesCursor: messages.status === 'fulfilled' ? messages.value.nextCursor : null,
      messagesError: messages.status === 'rejected' ? errText(messages.reason) : null,
      messagesMoreError: null,
      consent: consent.status === 'fulfilled' ? consent.value.records : [],
      consentError: consent.status === 'rejected' ? errText(consent.reason) : null,
      loading: false,
      loadingMoreEvents: false,
      loadingMoreMessages: false,
    });
  }, [enabled, profileId]);

  useEffect(() => {
    void loadBase();
    return () => {
      generation.current += 1;
    };
  }, [loadBase]);

  const retryEvents = useCallback(async () => {
    if (!enabled || !profileId) return;
    const gen = generation.current;
    setState((s) => ({ ...s, eventsError: null }));
    try {
      const value = await api.call('profiles.events', { profileId, limit: 100 });
      if (gen !== generation.current) return;
      setState((s) => ({ ...s, events: value.events, eventsCursor: value.nextCursor, eventsError: null }));
    } catch (e) {
      if (gen !== generation.current) return;
      setState((s) => ({ ...s, events: [], eventsCursor: null, eventsError: errText(e) }));
    }
  }, [enabled, profileId]);

  const retryMessages = useCallback(async () => {
    if (!enabled || !profileId) return;
    const gen = generation.current;
    setState((s) => ({ ...s, messagesError: null }));
    try {
      const value = await api.call('messages.list', { profileId, limit: 50 });
      if (gen !== generation.current) return;
      setState((s) => ({ ...s, messages: value.messages, messagesCursor: value.nextCursor, messagesError: null }));
    } catch (e) {
      if (gen !== generation.current) return;
      setState((s) => ({ ...s, messages: [], messagesCursor: null, messagesError: errText(e) }));
    }
  }, [enabled, profileId]);

  const retryConsent = useCallback(async () => {
    if (!enabled || !profileId) return;
    const gen = generation.current;
    setState((s) => ({ ...s, consentError: null }));
    try {
      const value = await api.call('consent.history', { profileId });
      if (gen !== generation.current) return;
      setState((s) => ({ ...s, consent: value.records, consentError: null }));
    } catch (e) {
      if (gen !== generation.current) return;
      setState((s) => ({ ...s, consent: [], consentError: errText(e) }));
    }
  }, [enabled, profileId]);

  const loadMoreEvents = useCallback(async () => {
    if (!enabled || !profileId || !state.eventsCursor || state.loadingMoreEvents) return;
    const gen = generation.current;
    setState((s) => ({ ...s, loadingMoreEvents: true, eventsMoreError: null }));
    try {
      const value = await api.call('profiles.events', {
        profileId,
        limit: 100,
        before: state.eventsCursor.timestamp,
        beforeId: state.eventsCursor.eventId,
        beforeName: state.eventsCursor.name,
        beforeAnonymousId: state.eventsCursor.anonymousId,
      });
      if (gen !== generation.current) return;
      setState((s) => ({
        ...s,
        events: [...s.events, ...value.events],
        eventsCursor: value.nextCursor,
        loadingMoreEvents: false,
        eventsMoreError: null,
      }));
    } catch (e) {
      if (gen !== generation.current) return;
      setState((s) => ({ ...s, loadingMoreEvents: false, eventsMoreError: errText(e) }));
    }
  }, [enabled, profileId, state.eventsCursor, state.loadingMoreEvents]);

  const loadMoreMessages = useCallback(async () => {
    if (!enabled || !profileId || !state.messagesCursor || state.loadingMoreMessages) return;
    const gen = generation.current;
    setState((s) => ({ ...s, loadingMoreMessages: true, messagesMoreError: null }));
    try {
      const value = await api.call('messages.list', { profileId, limit: 50, cursor: state.messagesCursor });
      if (gen !== generation.current) return;
      setState((s) => ({
        ...s,
        messages: [...s.messages, ...value.messages],
        messagesCursor: value.nextCursor,
        loadingMoreMessages: false,
        messagesMoreError: null,
      }));
    } catch (e) {
      if (gen !== generation.current) return;
      setState((s) => ({ ...s, loadingMoreMessages: false, messagesMoreError: errText(e) }));
    }
  }, [enabled, profileId, state.messagesCursor, state.loadingMoreMessages]);

  return {
    ...state,
    reload: loadBase,
    retryEvents,
    retryMessages,
    retryConsent,
    loadMoreEvents,
    loadMoreMessages,
  };
}
