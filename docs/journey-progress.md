# Journey progress UI

Once a train is explicitly boarded, the route timeline is stateful: completed ride legs are marked complete, the current ride is highlighted with a progress bar, future legs are deemphasized, and an active transfer shows a one-second remaining-time countdown plus a progress bar. The existing trip controller remains responsible for automatic ride → transfer → waiting → ride transitions.
