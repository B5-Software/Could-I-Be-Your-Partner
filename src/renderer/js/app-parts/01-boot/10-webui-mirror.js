  // Compatibility for existing view updates. No DOM observer or serialization:
  // each frontend renders the shared backend state with these same components.
  const WebUIMirror = { pushDomEvent() {}, _scheduleResync() {}, sendMirrorBody() {}, sendMirrorHead() {}, _applyingRemote: false };
