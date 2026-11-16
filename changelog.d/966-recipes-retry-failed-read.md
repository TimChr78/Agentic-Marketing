---
section: Fixed
issues: [966]
---
- On the Recipes page, Retry now repeats the read that failed: after a `recipes.get` (or the initial prerequisite preview) failure it reloads the selected starter, and after a `recipes.list` failure it reloads the gallery. The detail panel no longer sits on "Loading the starter" indefinitely, and its error is shown there with its own Retry instead of only above the gallery.
