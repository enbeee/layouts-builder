// Box Shadow — soft drop shadow for one box, drawn on a canvas-sized transparent
// color source ("Super Source • FX <n>") that sits UNDER the video inside the slot
// scene. Because the slot scene is canvas-sized, the shadow can spill beyond the
// box rect; overlapping boxes composite correctly via OBS alpha blending and the
// slot item order — impossible with the old chroma-key pipeline.
//
// All pixel uniforms are in CANVAS px (already divided by the SCALE_INNER fit
// factor server-side so values are final-screen pixels).
uniform float canvas_w;
uniform float canvas_h;
uniform float rect_l;
uniform float rect_t;
uniform float rect_r;
uniform float rect_b;
uniform float radius;     // corner radius, canvas px
uniform float blur;       // feather width, canvas px
uniform float spread;     // shadow growth, canvas px
uniform float offset_x;   // shadow offset, canvas px
uniform float offset_y;
uniform float4 shadow_color; // rgb + alpha (= shadow opacity)

float sdRoundedBox(float2 p, float2 b, float r) {
    float2 q = abs(p) - b + r;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

float4 mainImage(VertData v_in) : TARGET
{
    float2 px = v_in.uv * float2(canvas_w, canvas_h);

    float2 center = float2((rect_l + rect_r) * 0.5, (rect_t + rect_b) * 0.5) + float2(offset_x, offset_y);
    float2 half_size = float2((rect_r - rect_l) * 0.5 + spread, (rect_b - rect_t) * 0.5 + spread);
    float rad = max(radius + spread, 0.0);

    float d = sdRoundedBox(px - center, half_size, rad);

    // Feather from the shape edge outward: opaque at the edge, gone at +blur.
    float a = shadow_color.a * (1.0 - smoothstep(0.0, max(blur, 0.001), d));
    return float4(shadow_color.rgb, a);
}
