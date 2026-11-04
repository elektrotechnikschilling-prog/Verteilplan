# Verteilerplan-App · Elektrotechnik Schilling

Erstellt im Browser den fertigen Verteilerplan (Stromkreisverzeichnis) – aus Fotos des Verteilers,
aus dem in Craftnote ausgefüllten Aufnahmebogen oder per Antippen. Der Plan lässt sich als PDF speichern.

- Der Plan liegt nur auf dem Gerät; es gibt keinen eigenen Server.
- Fotoauswertung: Nur wenn sie benutzt wird, gehen die Fotos (ohne Kundenname und Adresse) direkt vom
  Gerät an die Claude-API von Anthropic. Dafür wird auf dem Gerät ein API-Schlüssel des Firmenkontos
  hinterlegt; er steht nie im Code.
- In diesem Repository liegen nur Programmcode, Logo und Firmendaten – keine Kundendaten, keine Schlüssel.

App: https://elektrotechnikschilling-prog.github.io/Verteilplan/
