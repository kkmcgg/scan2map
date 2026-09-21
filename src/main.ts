import "ol/ol.css";
import Map from "ol/Map";
import View from "ol/View";
import TileLayer from "ol/layer/Tile";
import OSM from "ol/source/OSM";

const el = document.getElementById("app")!;
el.style.cssText = "position:fixed;inset:0";

new Map({
  target: el,
  layers: [new TileLayer({ source: new OSM() })],
  view: new View({ center: [-7300000, 5600000], zoom: 7 }),
});
