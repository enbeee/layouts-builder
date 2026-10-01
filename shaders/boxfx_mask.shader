// Box Mask — rounded corners, border and per-box opacity with REAL alpha output.
// Applied to the video input inside each slot scene; replaces the old magenta
// chroma-key trick (no key filter, no fringing, no magenta content holes).
//
// Coordinate convention: uv is treated as canvas-relative (px = uv * canvas), which
// is exact for sources that fill the slot canvas. The crop rect selects the visible
// content; radius/border/AA come in already scaled from screen px into this space
// (server divides by the SCALE_INNER fit factor) and are normalized by the content
// width so corners stay circular regardless of aspect.
uniform float crop_left;
uniform float crop_right;
uniform float crop_top;
uniform float crop_bottom;
uniform float radius_norm;   // corner radius / content-screen-width
uniform float border_norm;   // border width / content-screen-width
uniform float aa_norm;       // anti-alias width / content-screen-width
uniform float norm_h;        // content screen height / content screen width
uniform float4 border_color; // rgb + alpha (= border opacity)
uniform float opacity;       // overall box opacity 0..1

float sdRoundedBox(float2 p, float2 b, float r) {
    float2 q = abs(p) - b + r;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

float4 mainImage(VertData v_in) : TARGET
{
    float4 src = image.Sample(textureSampler, v_in.uv);

    float cw = max(1.0 - crop_left - crop_right, 0.001);
    float ch = max(1.0 - crop_top - crop_bottom, 0.001);

    // Content-relative coords: x in [0,1], y scaled so 1 unit = content width.
    float x = (v_in.uv.x - crop_left) / cw;
    float y = (v_in.uv.y - crop_top) / ch;
    float2 p = float2(x, y * norm_h);
    float2 half_size = float2(0.5, 0.5 * norm_h);

    float d = sdRoundedBox(p, half_size, radius_norm);

    // Shape coverage with anti-aliased edge.
    float shapeAlpha = 1.0 - smoothstep(-aa_norm, aa_norm, d);
    if (shapeAlpha <= 0.0) return float4(0.0, 0.0, 0.0, 0.0);

    // Border band: last `border_norm` units inside the shape edge.
    float bm = smoothstep(-border_norm - aa_norm, -border_norm + aa_norm, d) * border_color.a;

    // Border OVER source (straight alpha compositing), then shape alpha + opacity.
    float A = bm + src.a * (1.0 - bm);
    float3 rgb = (border_color.rgb * bm + src.rgb * src.a * (1.0 - bm)) / max(A, 1e-5);
    return float4(rgb, A * shapeAlpha * opacity);
}
