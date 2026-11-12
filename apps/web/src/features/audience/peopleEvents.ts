// The People list keeps loaded pages so Previous can move back without another read. A write
// elsewhere, such as erasing a person, must drop those pages, exactly as `artifactCache` does for
// artifact names: a cached page must never present a removed person as a current row (#595).

type PeopleChangeListener = () => void;
const listeners = new Set<PeopleChangeListener>();

/** Registers a list cache that must be dropped when people change. Returns an unsubscribe. */
export function onPeopleChanged(listener: PeopleChangeListener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Tells every registered list that people changed, e.g. after `profiles.erase`. */
export function notifyPeopleChanged() {
  for (const listener of listeners) listener();
}
