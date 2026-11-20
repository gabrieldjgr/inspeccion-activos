# Inspección de Activos (PWA offline)

Especificación completa: `BRIEF_App_Inspeccion_Activos.md` (léela antes de cambiar algo). Estado y pruebas manuales: `README.md`. UI en español; código y comentarios en inglés.

## Reglas del proyecto
- Sitio estático, sin build. Rutas siempre **relativas** (vive en un subdirectorio de GitHub Pages). Nombres de archivo en **minúsculas**.
- Librerías externas solo **vendorizadas** en `vendor/` (nada de CDN): el service worker debe poder cachearlo todo.
- Cada release: subir la versión en **dos** sitios (`VERSION` en `sw.js` y `APP_VERSION` en `js/version.js`), añadir archivos nuevos a `PRECACHE` en `sw.js` y correr `node tools/check-precache.mjs`.
- Contratos de datos en `js/data.js` (congelados): los módulos de fotos/audio **nunca escriben el registro del activo**; viven en el store `blobs`. Dentro de `db.tx()` solo se hace `await` de peticiones IndexedDB (nada de `createImageBitmap`, `toBlob`, etc.).
- Los borradores viven en `assets` con `status:'draft'`: filtra siempre por `status` al contar, listar o exportar.
- Todo dato (edificios, departamentos, listas, activos) pertenece a un proyecto: filtra siempre por `project_id` (`db.getByProject`). Los cambios de esquema van como nueva versión en `db.js` dentro de la transacción de upgrade; nunca reescribir el store `blobs` en una migración.
- El ID visible (`display_id`, `B1-GA-A001`) solo se asigna dentro de `saveAsset`/`assignMissingDisplayIds` (transacción con el contador); nunca a mano. El proyecto activo de `h.state` puede estar desfasado: lee `last_context` de la base.
- Edificios: el modelo vive en `js/bldg-schema.js` (columnas del Excel, listas, unidades). Los campos van en `building.fields`; las medidas como `{value, unit, expr}`. Los medios del edificio usan `blobs.asset_id` = id del edificio; el formulario es el único que escribe el registro (más importación/restauración).
- La exportación para IA (`js/ai-export.js`) es un contrato con el procesamiento posterior: si cambias estructura o campos, sube `EXPORT_SCHEMA_VERSION` y actualiza `README_IA` y el README.
- Un activo está "por exportar" si `!exported_at || updated_at > exported_at`; no toques `updated_at` al marcar `exported_at`.

## Probar
`python -m http.server 8080` y abrir `http://localhost:8080`. El service worker es cache-first: al probar cambios, desregistrarlo y borrar cachés (o subir la versión y usar "Actualizar"). Cámara, micrófono, compartir y modo avión solo se prueban en dispositivo real (ver README).

## Trabajo en equipo
Una rama por tarea (`fase-x-tema`), PR a `main`, no editar los mismos archivos en paralelo. Commits en español, sin subir cosas sin que el usuario lo pida.
