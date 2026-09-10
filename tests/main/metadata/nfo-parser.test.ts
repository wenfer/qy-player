import { describe, expect, it } from 'vitest';
import {
  MAX_NFO_BYTES,
  decodeNfoBuffer,
  listSidecarCandidates,
  parseNfo,
  parseNfoXml,
} from '../../../src/main/modules/metadata/nfo-parser';

const MOVIE_NFO = `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<movie>
  <title>流浪地球</title>
  <originaltitle>The Wandering Earth</originaltitle>
  <sorttitle>Wandering Earth, The</sorttitle>
  <year>2019</year>
  <premiered>2019-02-05</premiered>
  <plot>太阳即将毁灭。</plot>
  <tagline>带着地球去流浪</tagline>
  <runtime>125</runtime>
  <rating>7.9</rating>
  <mpaa>PG-13</mpaa>
  <genre>科幻</genre>
  <genre>灾难</genre>
  <studio>中影</studio>
  <country>中国大陆</country>
  <director>郭帆</director>
  <actor>
    <name>吴京</name>
    <role>刘培强</role>
    <thumb>http://example.local/wu.jpg</thumb>
  </actor>
  <actor><name>李光洁</name><role>王磊</role></actor>
  <uniqueid type="imdb">tt7601826</uniqueid>
  <uniqueid type="tmdb" default="true">522499</uniqueid>
  <thumb>http://example.local/poster.jpg</thumb>
  <set><name>流浪地球系列</name></set>
</movie>`;

describe('nfo parser', () => {
  it('parses a complete movie NFO', () => {
    const meta = parseNfoXml(MOVIE_NFO);
    expect(meta.kind).toBe('movie');
    expect(meta.title).toBe('流浪地球');
    expect(meta.originalTitle).toBe('The Wandering Earth');
    expect(meta.sortTitle).toBe('Wandering Earth, The');
    expect(meta.year).toBe(2019);
    expect(meta.premiered).toBe('2019-02-05');
    expect(meta.plot).toBe('太阳即将毁灭。');
    expect(meta.tagline).toBe('带着地球去流浪');
    expect(meta.runtime).toBe(125);
    expect(meta.rating).toBeCloseTo(7.9);
    expect(meta.contentRating).toBe('PG-13');
    expect(meta.genres).toEqual(['科幻', '灾难']);
    expect(meta.studios).toEqual(['中影']);
    expect(meta.countries).toEqual(['中国大陆']);
    expect(meta.directors).toEqual(['郭帆']);
    expect(meta.actors).toEqual([
      { name: '吴京', role: '刘培强', thumb: 'http://example.local/wu.jpg' },
      { name: '李光洁', role: '王磊' },
    ]);
    expect(meta.uniqueIds).toEqual([
      { provider: 'imdb', id: 'tt7601826' },
      { provider: 'tmdb', id: '522499', isDefault: true },
    ]);
    expect(meta.thumbs).toEqual(['http://example.local/poster.jpg']);
    expect(meta.set).toBe('流浪地球系列');
  });

  it('parses tvshow / season / episodedetails roots', () => {
    const show = parseNfoXml('<tvshow><title>Friends</title><season>-1</season></tvshow>');
    expect(show.kind).toBe('tvshow');
    const season = parseNfoXml('<season><season>2</season><title>第二季</title></season>');
    expect(season.kind).toBe('season');
    expect(season.season).toBe(2);
    const episode = parseNfoXml('<episodedetails><title>The One</title><season>1</season><episode>3</episode></episodedetails>');
    expect(episode.kind).toBe('episode');
    expect(episode.season).toBe(1);
    expect(episode.episode).toBe(3);
  });

  it('decodes predefined and numeric entities but rejects unknown ones', () => {
    expect(parseNfoXml('<movie><title>A &amp; B &lt;C&gt; &#39;x&#39; &#x4E2D;</title></movie>').title)
      .toBe("A & B <C> 'x' 中");
    expect(() => parseNfoXml('<movie><title>&evil;</title></movie>')).toThrow(/实体/);
  });

  it('supports CDATA and skips comments', () => {
    const meta = parseNfoXml(
      '<movie><!-- 注释 --><title><![CDATA[A <b> raw]]></title></movie>'
    );
    expect(meta.title).toBe('A <b> raw');
  });

  it('takes the first non-empty value for duplicate scalar tags', () => {
    const meta = parseNfoXml('<movie><title></title><title>真的标题</title><title>别的</title></movie>');
    expect(meta.title).toBe('真的标题');
  });

  it('rejects DOCTYPE outright', () => {
    expect(() => parseNfoXml('<!DOCTYPE movie [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><movie><title>&xxe;</title></movie>')).toThrow(/DOCTYPE/);
  });

  it('rejects malformed documents', () => {
    expect(() => parseNfoXml('<movie><title>未闭合</title>')).toThrow();
    expect(() => parseNfoXml('<movie><title></wrong></movie>')).toThrow();
    expect(() => parseNfoXml('<movie.attr=1>文本</movie>')).toThrow();
    expect(() => parseNfoXml('纯文本，没有根元素')).toThrow();
    expect(() => parseNfoXml('')).toThrow();
  });

  it('enforces the depth and node caps', () => {
    const deep = '<movie>' + '<a>'.repeat(40) + 'x' + '</a>'.repeat(40) + '</movie>';
    expect(() => parseNfoXml(deep)).toThrow(/深度/);
    // 55,000 elements + root > the 50,000 node cap.
    const many = `<movie>${'<a>y</a>'.repeat(55_000)}</movie>`;
    expect(() => parseNfoXml(many)).toThrow(/节点/);
  });

  it('enforces the 2 MiB limit on both text and buffers', () => {
    const huge = `<movie><title>${'a'.repeat(MAX_NFO_BYTES)}</title></movie>`;
    expect(() => parseNfoXml(huge)).toThrow(/大小/);
    const bigBuffer = Buffer.alloc(MAX_NFO_BYTES + 1, 0x61);
    expect(() => decodeNfoBuffer(bigBuffer)).toThrow(/大小/);
  });

  it('decodes UTF-8 BOM, UTF-16LE and UTF-16BE buffers', () => {
    const xml = '<movie><title>字幕测试</title></movie>';
    const utf8Bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(xml, 'utf8')]);
    expect(decodeNfoBuffer(utf8Bom)).toBe(xml);

    const utf16le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]);
    expect(decodeNfoBuffer(utf16le)).toBe(xml);

    // Manual BE encoding: swap the LE byte pairs and prepend the BE BOM.
    const le = Buffer.from(xml, 'utf16le');
    const be = Buffer.alloc(le.length);
    for (let i = 0; i < le.length; i += 2) {
      be[i] = le[i + 1];
      be[i + 1] = le[i];
    }
    const utf16be = Buffer.concat([Buffer.from([0xfe, 0xff]), be]);
    expect(decodeNfoBuffer(utf16be)).toBe(xml);

    // No BOM: treated as UTF-8.
    expect(decodeNfoBuffer(Buffer.from(xml, 'utf8'))).toBe(xml);
  });

  it('accepts legal depth exactly at the cap and legal entities', () => {
    // 32 levels total (root + 31 nested) is within the cap.
    const legal = '<movie>' + '<a>'.repeat(31) + 'x' + '</a>'.repeat(31) + '</movie>';
    expect(() => parseNfoXml(legal)).not.toThrow();
    expect(parseNfoXml('<movie><title>正常 &amp; 合法实体 &#x4E2D;</title></movie>').title)
      .toBe('正常 & 合法实体 中');
  });

  it('accepts a self-closing root and trailing comments', () => {
    expect(parseNfoXml('<movie/>').kind).toBe('movie');
    expect(parseNfoXml('<movie><!-- 尾部注释 --></movie><!-- 允许 -->').kind).toBe('movie');
    expect(() => parseNfoXml('</movie><movie></movie>')).toThrow();
    expect(() => parseNfoXml('<movie></movie>多废话')).toThrow();
  });

  it('rejects out-of-range and surrogate numeric entities', () => {
    expect(() => parseNfoXml('<movie><title>&#x110000;</title></movie>')).toThrow(/非法数字实体/);
    expect(() => parseNfoXml('<movie><title>&#xD800;</title></movie>')).toThrow(/非法数字实体/);
  });

  it('prefers <contentrating> when both rating tags exist', () => {
    const meta = parseNfoXml('<movie><mpaa>R</mpaa><contentrating>PG-13</contentrating></movie>');
    expect(meta.contentRating).toBe('PG-13');
  });

  it('rejects illegal tag and attribute names', () => {
    expect(() => parseNfoXml('<123>x</123>')).toThrow(/非法标签名/);
    expect(() => parseNfoXml('<movie><title!>x</title></movie>')).toThrow();
    expect(() => parseNfoXml('<movie bad!=x>x</movie>')).toThrow();
  });

  it('parses from a buffer end-to-end', () => {
    const meta = parseNfo(Buffer.from(MOVIE_NFO, 'utf8'));
    expect(meta.kind).toBe('movie');
    expect(meta.title).toBe('流浪地球');
  });

  it('lists sidecar image candidates for a video base name', () => {
    const dirEntries = ['poster.jpg', 'fanart.png', 'movie.nfo', 'other.jpg', 'Movie (2019)-poster.jpg'];
    const candidates = listSidecarCandidates(dirEntries, 'Movie (2019)');
    expect(candidates).toContain('poster.jpg');
    expect(candidates).toContain('fanart.png');
    expect(candidates).toContain('Movie (2019)-poster.jpg');
    expect(candidates).not.toContain('other.jpg');
    expect(candidates).not.toContain('movie.nfo');
  });
});
