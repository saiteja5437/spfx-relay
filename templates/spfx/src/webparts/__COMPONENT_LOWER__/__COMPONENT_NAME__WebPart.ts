import * as React from 'react';
import * as ReactDom from 'react-dom';
import { Version } from '@microsoft/sp-core-library';
import { BaseClientSideWebPart } from '@microsoft/sp-webpart-base';

import __COMPONENT_NAME__ from './components/__COMPONENT_NAME__';

export interface I__COMPONENT_NAME__WebPartProps {}

export default class __COMPONENT_NAME__WebPart extends BaseClientSideWebPart<I__COMPONENT_NAME__WebPartProps> {
  public render(): void {
    const element: React.ReactElement = React.createElement(__COMPONENT_NAME__);
    ReactDom.render(element, this.domElement);
  }

  protected onDispose(): void {
    ReactDom.unmountComponentAtNode(this.domElement);
  }

  protected get dataVersion(): Version {
    return Version.parse('1.0');
  }
}
