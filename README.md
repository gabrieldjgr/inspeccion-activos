# Inspección de Activos (PWA offline)

App web instalable para registrar activos en campo, 100 % offline después de la primera carga. Sitio estático (HTML + CSS + JS, sin build) pensado para GitHub Pages. La especificación completa está en `BRIEF_App_Inspeccion_Activos.md`.

**Estado: v0.3.0 — F0 (proyectos) del plan v0.3.** Sobre la base v0.2 (registro, fotos, audio, exportación ZIP, respaldo) se agregan proyectos, código de valuador, paquete de proyecto y la migración segura de los datos existentes. Verificado en Chromium de escritorio con pruebas automatizadas (migración v1→v2 con datos reales de v0.2.2, fallo simulado a mitad de la migración, aislamiento entre proyectos, paquetes y restauración de respaldos v1/v2). **Sin probar aún en dispositivo real:** cámara, micrófono, compartir y modo avión (ver pruebas manuales abajo).

## Estructura

```
index.html  styles.css  manifest.webmanifest  sw.js  .nojekyll
js/    app.js (rutas, ajustes, edificios) · assets.js (formulario, lista, departamentos) · data.js (contratos de datos)
       projects.js (proyectos, paquete de proyecto) · migrate.js (pantalla de migración v1→v2)
       photos.js · audio.js · export.js · db.js (IndexedDB) · csv.js · version.js
css/   photos.css · audio.css · export.css      vendor/ fflate.esm.js (ZIP, vendorizado)
icons/ iconos PNG (any, maskable, apple-touch)
tools/ make-icons.ps1 · check-precache.mjs
edificios_ejemplo.csv
```

Todos los nombres de archivo van en **minúsculas**: GitHub Pages distingue mayúsculas y un solo error en la lista de precaché impide que el service worker se instale. Antes de cada publicación:

```bash
node tools/check-precache.mjs
```

## Probar en local

```bash
python -m http.server 8080
```

Abre `http://localhost:8080` (localhost cuenta como contexto seguro, el service worker funciona).

## Publicar en GitHub Pages

1. Crea un repositorio en GitHub (p. ej. `inspeccion-activos`) y sube estos archivos a la raíz de la rama `main`.
2. En el repositorio: **Settings → Pages → Build and deployment → Source: Deploy from a branch → Branch: `main` / `/ (root)` → Save**.
3. Espera ~1 minuto. La app queda en `https://USUARIO.github.io/inspeccion-activos/`.
4. Todas las rutas de la app son relativas, así que funciona dentro del subdirectorio del repo.

## Instalar la PWA

- **Android (Chrome):** abre la URL **con internet** una vez → menú ⋮ → *Instalar app*. Ábrela desde el ícono y prueba en modo avión.
- **iPhone (Safari 16.4+):** abre la URL en Safari → Compartir → *Añadir a pantalla de inicio*. Abre siempre desde el ícono. iOS limita más el almacenamiento y puede borrarlo si no se usa la app durante semanas; exporta con frecuencia.

## Publicar una versión nueva

1. Cambia la versión en **dos** sitios: `VERSION` en `sw.js` y `APP_VERSION` en `js/version.js` (el script `check-precache.mjs` falla si no coinciden).
2. Si agregaste archivos nuevos, añádelos a `PRECACHE` en `sw.js`.
3. `node tools/check-precache.mjs`, commit y push.
4. En el teléfono, al abrir la app aparece el aviso **"Hay una nueva versión — Actualizar"**. También: Ajustes → *Buscar actualización*. La app nunca se actualiza sola a mitad de un registro.
5. Para forzar: cerrar la app por completo y reabrir, o en Chrome → Configuración del sitio → Borrar datos (**¡borra los registros!**; exporta antes).

## Formato del CSV de edificios

Exactamente 2 columnas con encabezados `BLDG #` y `BLDG NAME` (mayúsculas/espacios no importan).

```csv
BLDG #,BLDG NAME
B-01,Edificio Administrativo
B-05,"Taller de Mantenimiento, Anexo"
```

- Separador `,` o `;` (se detecta solo). Acepta BOM UTF-8, comillas, espacios extra y acentos.
- Si el archivo no es UTF-8 (Excel en español guarda en ANSI/Windows-1252) se reinterpreta automáticamente.
- Códigos `BLDG #` duplicados (sin distinguir mayúsculas): se avisa y se conserva la primera fila.
- Al importar con una lista existente se elige **Reemplazar** o **Fusionar**.
- *Exportar CSV* en Edificios descarga `edificios.csv` (UTF-8 con BOM).
- Para dar la misma lista a todos los inspectores, compartan el mismo CSV. `edificios_ejemplo.csv` es solo de prueba.

## Modelo de datos (resumen)

- `projects`: un registro por proyecto (nombre, cliente, planta, unidades, **código de valuador de este teléfono**, `status` `active` | `archived`, `last_context`). El proyecto activo está en `settings.active_project`.
- `buildings` (clave uuid, código único por proyecto), `departments` (`{project_id}|{KEY}`) y `lists` (valores agregados por el usuario, F2) llevan `project_id`.
- `assets`: un registro por activo, con `project_id` y `building_id` (`status` `draft` | `saved`). El borrador se autoguarda en cada cambio; el `seq` se asigna al guardar por primera vez.
- `blobs`: fotos (`photo`), miniaturas (`thumb`), audios (`audio`) y trozos de grabación en curso (`audiochunk`). Los módulos de medios nunca escriben el registro del activo; `photos[]`/`audios[]` se arman al exportar.
- Contexto recordado por proyecto en `projects.last_context`. Un activo está "por exportar" si nunca se exportó o se editó después (`updated_at > exported_at`).

## Proyectos y migración (v0.3)

- Cada proyecto tiene sus edificios, departamentos, activos y exportaciones. El proyecto activo se ve siempre en la barra superior; tocarlo abre **Proyectos** (crear, editar, usar, archivar, reactivar). Archivar no borra nada.
- **Código de valuador** (2–3 letras): se pide al crear el proyecto y va en los IDs de activo (`B1-GA-A001`, fase F1). Cada valuador del mismo proyecto usa uno distinto.
- **Paquete de proyecto** (`proyecto_{nombre}.json`): proyecto + edificios + departamentos + listas, sin fotos, activos ni código de valuador. Un coordinador lo comparte y los demás lo importan en Proyectos → *Importar paquete*: todos quedan con el mismo id de proyecto y los mismos ids de edificio. Importarlo de nuevo solo agrega lo que falte.
- **Migración desde v0.2:** al abrir la versión nueva con datos anteriores aparece *Actualización de datos*: 1) descargar respaldo (formato v0.2, se puede restaurar incluso en la versión anterior); 2) actualizar. Todo pasa a "Proyecto 1". La actualización es una única transacción: si falla, la base queda exactamente como estaba; las fotos y audios no se reescriben. Además se guarda una copia interna (`_v1_backup`) de edificios, departamentos y contexto.
- **Respaldo completo** (Exportar): incluye todos los proyectos. Restaurar un respaldo v0.2 lo carga en el proyecto activo; uno v0.3 agrega proyectos/edificios que falten y fusiona activos por id (gana el más reciente).

## Formato del ZIP exportado

`inspeccion_{proyecto}_{device8}_{YYYYMMDD-HHmm}_parte{n}.zip` con `manifest.json` (con `project` y `valuer_code`), `activos.csv` (UTF-8 con BOM), `activos.json`, `edificios.csv` y `activos/{BLDG}_{seq4}_{uuid8}/` con `activo.json`, `foto_NN.jpg`, `captura_NN.png`, `audio_NN.webm|m4a` y `notas.txt`. Se parte en varios ZIP según el tamaño máximo elegido. El respaldo completo (`respaldo_*.zip`) se restaura desde Exportar → *Restaurar respaldo*.

## Transcribir las notas de voz (escritorio)

La app solo graba los audios. Para transcribirlos en tu PC (Whisper local, español) usa `tools/transcribir_audios.py`: toma los ZIP exportados y devuelve una copia con el campo `transcript` de cada audio rellenado, más `transcripciones.csv`. Instrucciones y requisitos en `tools/README_transcribir.md`.

## Pruebas manuales en el S21 Ultra — Fase 1

1. Abrir la URL en Chrome con internet → *Instalar app*.
2. Abrir desde el ícono; escribir el nombre en Ajustes.
3. Activar **modo avión**, cerrar la app por completo (deslizar), reabrir: debe cargar y mostrar el nombre.
4. Importar `edificios_ejemplo.csv` y, además, un CSV guardado desde Excel (con `;` y acentos) → los acentos deben verse bien.
5. Ajustes → almacenamiento persistente debe decir *Sí*.

## Pruebas manuales en el S21 Ultra — Fases 2–6

1. Registrar 10 activos en modo avión; cerrar la app por completo y reabrir: todo sigue y el contexto (edificio/piso/departamento) se recuerda.
2. **Tomar foto** abre la cámara nativa; 20 fotos en un activo; zoom sobre una placa de datos legible. **Agregar de galería** con capturas de pantalla.
3. Con la cámara abierta, forzar el cierre de Chrome: al volver debe existir el borrador.
4. Grabar 5 audios en modo avión, reiniciar la app y reproducirlos. Cerrar la app grabando: al reabrir debe avisar que recuperó la nota.
5. Exportar 50 activos con fotos: abrir el ZIP en Windows; `activos.csv` en Excel con acentos correctos; probar *Compartir*.
6. Crear respaldo, borrar datos del sitio y restaurar.
7. iPhone (Safari 16.4+): mismo flujo; audio sale como `.m4a`.

## Pruebas manuales — v0.3 F0 (proyectos y migración)

1. **Con datos de v0.2 en el teléfono** (no borres nada): actualizar la app → aparece *Actualización de datos* con el conteo de activos, fotos y audios. *Descargar respaldo*, guardarlo fuera del teléfono, *Actualizar mis datos*. Comprobar que la lista muestra los mismos activos con sus miniaturas, que las fotos y audios abren y que el borrador pendiente (si había) sigue.
2. En **Proyectos**: renombrar "Proyecto 1", poner tu código de valuador. Crear un segundo proyecto: su lista de activos, edificios y departamentos debe estar vacía. Volver al primero: todo sigue, y *Nuevo activo* recuerda el último edificio/piso/departamento de ese proyecto.
3. El nombre del proyecto activo se ve siempre arriba; tocarlo abre Proyectos.
4. *Compartir paquete* → enviarlo por WhatsApp a otro teléfono → *Importar paquete de proyecto* → pide el código de valuador → aparecen los mismos edificios.
5. Archivar el proyecto activo: la app pide elegir otro; reactivarlo desde *Archivados*.
6. Exportar ZIP: el nombre incluye el proyecto y solo trae activos de ese proyecto.
7. Modo avión: crear un proyecto y un activo sin conexión.
