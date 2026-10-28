# Boundary data sources

## lagos_area_lga_grid3_2022.geojson

- **Content:** Local Government Area (ADM2) polygons whose centroid lies in the Lagos bounding box
  (lon 2.6–4.4, lat 6.3–6.75). That is the 20 Lagos LGAs plus 3 neighbouring Ogun State LGAs. The importer
  reports the Ogun features as unmatched instead of using them.
- **Original source:** GRID3 Nigeria, 2022 (as published by geoBoundaries, gbOpen NGA ADM2, simplified geometry).
- **Retrieved from:** https://github.com/wmgeolab/geoBoundaries/raw/9469f09/releaseData/gbOpen/NGA/ADM2/geoBoundaries-NGA-ADM2_simplified.geojson
  (metadata: https://www.geoboundaries.org/api/current/gbOpen/NGA/ADM2/), retrieved 2026-10-26.
- **License:** Creative Commons Attribution 4.0 International (CC BY 4.0). Attribution must be shown
  wherever the map is displayed; the explorer does this automatically.
- **Processing:** subset by bounding box; properties reduced to `shapeName`, `shapeID`; coordinates rounded to 5 decimals (~1 m).
  No geometry was edited.

### Limitations

- These are administrative LGA boundaries, not INEC delimitation boundaries. They are suitable for
  LGA-level shading only.
- **Ward (registration area) and polling-unit boundaries are not included.** INEC registration areas
  do not correspond to GRID3 operational wards, and no verified source has been supplied. Ward and polling-unit
  levels are therefore shown as tables, not maps, until verified boundaries or coordinates are provided.
- Simplified geometry: shapes are generalised and must not be used for any legal or delimitation purpose.
