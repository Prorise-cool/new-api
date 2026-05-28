/*
Copyright (C) 2025 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/

import React, { useContext, useEffect, useState } from 'react';
import {
  Button,
  Card,
  Form,
  Space,
  Typography,
} from '@douyinfe/semi-ui';
import { API, showError, showSuccess } from '../../../helpers';
import {
  CUSTOM_NAV_ANCHORS,
  parseCustomNavItems,
  serializeCustomNavItems,
} from '../../../helpers/customNavItems';
import { useTranslation } from 'react-i18next';
import { StatusContext } from '../../../context/Status';

const { Text, Paragraph } = Typography;

const SAMPLE = JSON.stringify(
  [
    {
      id: 'studio',
      title: '我的创作台',
      url: 'https://newapi.prorisehub.com/',
      target: 'blank',
      icon: 'Sparkles',
      requireAuth: false,
      enabled: true,
      anchor: 'console',
      position: 'after',
      order: 0,
    },
  ],
  null,
  2,
);

/**
 * Minimal classic-UI editor for CustomNavItems.
 *
 * Rich CRUD (table, dialog, icon preview) lives on the default theme. This
 * page accepts the same JSON document so that operators on the classic theme
 * can still configure custom nav items without switching themes.
 */
export default function SettingsCustomNavItems(props) {
  const { t } = useTranslation();
  const [statusState, statusDispatch] = useContext(StatusContext);
  const [raw, setRaw] = useState('[]');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const incoming = props.options?.CustomNavItems;
    if (typeof incoming === 'string' && incoming.trim() !== '') {
      setRaw(incoming);
    } else {
      setRaw('[]');
    }
  }, [props.options]);

  // Validate JSON shape locally before sending — gives a clearer error than
  // the generic backend reply when the admin pastes malformed JSON.
  function validate(text) {
    try {
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) {
        return t('必须是 JSON 数组');
      }
      for (let i = 0; i < parsed.length; i++) {
        const item = parsed[i];
        if (!item || typeof item !== 'object') {
          return t('第 {{n}} 项不是对象', { n: i + 1 });
        }
        if (typeof item.url !== 'string' || !item.url.trim()) {
          return t('第 {{n}} 项缺少 url', { n: i + 1 });
        }
        if (item.anchor && !CUSTOM_NAV_ANCHORS.includes(item.anchor)) {
          return t('第 {{n}} 项 anchor 无效', { n: i + 1 });
        }
      }
      return '';
    } catch (e) {
      return t('JSON 解析失败: ') + (e.message || e);
    }
  }

  async function onSubmit() {
    const msg = validate(raw);
    if (msg) {
      setError(msg);
      return;
    }
    setError('');
    // Normalize through parser to drop unknown fields and apply defaults.
    const normalized = serializeCustomNavItems(parseCustomNavItems(raw));
    setLoading(true);
    try {
      const res = await API.put('/api/option/', {
        key: 'CustomNavItems',
        value: normalized,
      });
      const { success, message } = res.data;
      if (success) {
        showSuccess(t('保存成功'));
        statusDispatch({
          type: 'set',
          payload: {
            ...statusState.status,
            CustomNavItems: normalized,
          },
        });
        setRaw(normalized);
        if (props.refresh) await props.refresh();
      } else {
        showError(message);
      }
    } catch (e) {
      showError(t('保存失败，请重试'));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card>
      <Form.Section
        text={t('自定义顶部导航项')}
        extraText={t('为顶部导航栏追加内/外链按钮，支持锚定到内置项之间')}
      >
        <Paragraph type='tertiary' style={{ marginBottom: 12 }}>
          {t(
            '推荐在 default 主题的「站点管理 → 自定义导航项」中可视化编辑；此处接受相同的 JSON 文档。anchor 可选：',
          )}{' '}
          <Text code>{CUSTOM_NAV_ANCHORS.join(', ')}</Text>。{' '}
          {t('position 可选：')}
          <Text code>before</Text>/<Text code>after</Text>。
        </Paragraph>

        <Form.TextArea
          field='custom_nav_items_raw'
          label={t('JSON 配置')}
          noLabel
          value={raw}
          onChange={(v) => setRaw(v)}
          rows={14}
          placeholder={SAMPLE}
          style={{ fontFamily: 'JetBrains Mono, Consolas, monospace' }}
        />

        {error && (
          <Text type='danger' style={{ display: 'block', marginTop: 8 }}>
            {error}
          </Text>
        )}

        <Space style={{ marginTop: 16 }}>
          <Button theme='solid' loading={loading} onClick={onSubmit}>
            {t('保存')}
          </Button>
          <Button
            onClick={() => {
              setRaw(SAMPLE);
              setError('');
            }}
          >
            {t('填入示例')}
          </Button>
        </Space>
      </Form.Section>
    </Card>
  );
}
