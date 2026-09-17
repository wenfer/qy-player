import { configure } from '@testing-library/react';

/**
 * 测试全局配置。
 *
 * 并行跑 80+ 个文件时（老机器 + jsdom 环境创建开销），
 * `findBy*`/`waitFor` 的默认 1s 异步超时会产生假红——实测在
 * library/local-library、detail/metadata-editor、home/unified-sources
 * 三个用例上偶发，单跑必过。放宽到 4s 消除这类噪声；真正卡住的用例
 * 仍然会失败，只是多等几秒。
 */
configure({ asyncUtilTimeout: 4000 });
